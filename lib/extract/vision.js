'use strict';

const { config } = require('../config');

// Cloudflare Workers AI over plain HTTPS — no SDK.
//
// The two models genuinely disagree about request shape, which is why this is
// built as adapters rather than one assumed body:
//
//   moondream  native `ai/run/{model}` with {task, image, question}
//   llama      OpenAI-compatible `ai/v1/chat/completions` with image_url blocks
//
// The Workers AI catalog changes often. If a model ID has been retired we fail
// loudly with the model name in the message rather than quietly returning
// nothing, because a silent degradation here looks exactly like a blank card.

const BASE = accountId => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`;

class VisionError extends Error {
  constructor(message, { model, status, retryable = false, retired = false, agreementRequired = false, body } = {}) {
    super(message);
    this.name = 'VisionError';
    this.model = model;
    this.status = status;
    this.retryable = retryable;
    this.retired = retired;
    this.agreementRequired = agreementRequired;
    this.body = body;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Some Workers AI models (Meta's Llama vision family among them) are gated
 * behind a one-time licence acceptance on the account. Until someone accepts,
 * every inference returns 403. That is an account action with legal weight, so
 * we surface exactly how to do it rather than accepting it automatically.
 */
function needsAgreement(payload) {
  const errors = (payload && payload.errors) || [];
  return errors.some(error => /model agreement|must submit the prompt/i.test(error.message || ''));
}

/** Cloudflare error codes / messages that mean "this model no longer exists". */
function looksRetired(status, payload) {
  if (status === 404) return true;
  const errors = (payload && payload.errors) || [];
  return errors.some(error => {
    const text = `${error.code || ''} ${error.message || ''}`.toLowerCase();
    return text.includes('no such model')
      || text.includes('model not found')
      || text.includes('unknown model')
      || text.includes('deprecated');
  });
}

// ---------------------------------------------------------------------------
// Adapters

const adapters = {
  /**
   * Moondream: native path, task-based body. `image` takes a data URI or a
   * public HTTPS URL. It is NOT OpenAI chat-compatible.
   */
  moondream: {
    matches: model => /moondream/i.test(model),
    path: model => `/run/${model}`,
    body: ({ prompt, dataUri, maxTokens }) => ({
      task: 'query',
      image: dataUri,
      question: prompt,
      max_tokens: maxTokens,
      // Verified against the live API: `stream` defaults to TRUE on this model,
      // and a streaming request returns `{"result":{}}` over the REST endpoint —
      // HTTP 200, success true, and no content whatsoever. This flag is what
      // makes the model actually answer.
      stream: false
    }),
    text: payload => {
      const outer = payload && payload.result;
      if (!outer) return '';
      if (typeof outer === 'string') return outer;
      // Verified against the live API: the payload is double-nested as
      // result.result.answer, which the published schema does not show.
      const result = outer.result && typeof outer.result === 'object' ? outer.result : outer;
      if (typeof result.answer === 'string') return result.answer;
      if (typeof result.caption === 'string') return result.caption;
      if (typeof result.response === 'string') return result.response;
      if (typeof result.description === 'string') return result.description;
      if (Array.isArray(result.choices) && result.choices[0]) {
        return result.choices[0].message?.content || result.choices[0].text || '';
      }
      return '';
    }
  },

  /**
   * Llama 3.2 Vision: the OpenAI-compatible /v1/chat/completions route
   * rejects this model's image parts ("Unable to add image when there are no
   * user-supplied nor system-supplied messages", code 3030 — observed live
   * the moment the licence was accepted). Probed against the live API: the
   * NATIVE run path accepts the same content-parts message with a data-URI
   * image, and when the model answers in JSON, Workers AI returns
   * `result.response` PRE-PARSED as an object rather than a string.
   */
  llamaVision: {
    matches: model => /llama.*vision/i.test(model),
    path: model => `/run/${model}`,
    body: ({ prompt, dataUri, maxTokens }) => ({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUri } }
        ]
      }],
      max_tokens: maxTokens
    }),
    text: payload => {
      const result = payload && payload.result;
      if (!result) return '';
      if (typeof result === 'string') return result;
      if (result.response != null) {
        return typeof result.response === 'string' ? result.response : JSON.stringify(result.response);
      }
      if (typeof result.description === 'string') return result.description;
      const choice = (result.choices || [])[0];
      return choice ? (choice.message?.content || choice.text || '') : '';
    }
  },

  /** Other chat-style vision models: OpenAI-compatible chat completions. */
  chat: {
    matches: () => true, // default
    path: () => '/v1/chat/completions',
    body: ({ model, prompt, dataUri, maxTokens }) => ({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUri } }
        ]
      }]
    }),
    text: payload => {
      if (!payload) return '';
      const choice = (payload.choices || [])[0];
      if (choice) return choice.message?.content || choice.text || '';
      // Workers AI sometimes wraps the OpenAI shape in its own envelope.
      const result = payload.result;
      if (result) {
        if (typeof result.response === 'string') return result.response;
        const inner = (result.choices || [])[0];
        if (inner) return inner.message?.content || inner.text || '';
      }
      return '';
    }
  }
};

const adapterFor = model => {
  if (adapters.moondream.matches(model)) return adapters.moondream;
  if (adapters.llamaVision.matches(model)) return adapters.llamaVision;
  return adapters.chat;
};

// ---------------------------------------------------------------------------

/**
 * Create a Workers AI client.
 * `fetchImpl` is injectable so the test suite never touches the network.
 */
function createVisionClient(options = {}) {
  // `??` not `||`: an explicitly empty credential means "unconfigured" and must
  // not silently fall through to whatever happens to be in .env.
  const accountId = options.accountId ?? config.cloudflare.accountId;
  const apiToken = options.apiToken ?? config.cloudflare.apiToken;
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs || config.cloudflare.timeoutMs;
  const retries = options.retries == null ? config.cloudflare.retries : options.retries;

  const configured = Boolean(accountId && apiToken);

  async function callOnce(model, { prompt, dataUri, maxTokens }) {
    const adapter = adapterFor(model);
    const url = `${BASE(accountId)}${adapter.path(model)}`;
    const body = adapter.body({ model, prompt, dataUri, maxTokens });

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      // Timeouts and socket failures are worth retrying.
      throw new VisionError(`${model}: request failed (${error.message})`, { model, retryable: true });
    }

    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch { /* handled below */ }

    if (!response.ok) {
      if (needsAgreement(payload)) {
        throw new VisionError(
          `Workers AI model "${model}" requires a one-time licence acceptance on this account. ` +
          `Accept it by running:\n  curl -X POST "${BASE(accountId)}/run/${model}" ` +
          `-H "Authorization: Bearer $CF_API_TOKEN" -d '{"prompt":"agree"}'`,
          { model, status: response.status, agreementRequired: true, body: raw.slice(0, 500) }
        );
      }
      if (looksRetired(response.status, payload)) {
        throw new VisionError(
          `Workers AI model "${model}" is unavailable (HTTP ${response.status}). ` +
          'The model may have been retired — check the Workers AI catalog and update CF_MODEL_PRIMARY / CF_MODEL_CROSS_CHECK.',
          { model, status: response.status, retired: true, body: raw.slice(0, 500) }
        );
      }
      const retryable = response.status === 429 || response.status >= 500;
      throw new VisionError(`${model}: HTTP ${response.status}`, {
        model, status: response.status, retryable, body: raw.slice(0, 500)
      });
    }

    if (!payload) throw new VisionError(`${model}: response was not JSON`, { model, body: raw.slice(0, 500) });
    if (payload.success === false && looksRetired(response.status, payload)) {
      throw new VisionError(
        `Workers AI model "${model}" is unavailable. It may have been retired — check the Workers AI catalog.`,
        { model, retired: true, body: raw.slice(0, 500) }
      );
    }
    if (payload.success === false) {
      const message = (payload.errors || []).map(error => error.message).join('; ') || 'unknown error';
      throw new VisionError(`${model}: ${message}`, { model, body: raw.slice(0, 500) });
    }

    const text = adapterFor(model).text(payload);
    if (!text) {
      // Observed intermittently against the live API: HTTP 200, success true,
      // and an empty result for an image that reads fine on the next attempt.
      // This is transient, so it is worth retrying rather than falling all the
      // way through to local OCR.
      throw new VisionError(`${model}: response contained no text`, {
        model, retryable: true, body: raw.slice(0, 500)
      });
    }
    return text;
  }

  return {
    configured,
    accountId,

    /** Run one vision model against one image, with backoff. */
    async run(model, { prompt, dataUri, maxTokens = 768 }) {
      if (!configured) {
        throw new VisionError('Workers AI is not configured (CF_ACCOUNT_ID / CF_API_TOKEN missing)', { model });
      }

      let lastError = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await callOnce(model, { prompt, dataUri, maxTokens });
        } catch (error) {
          lastError = error;
          // A retired model will never succeed; stop immediately and surface it.
          if (error.retired || !error.retryable || attempt === retries) break;
          await sleep(2 ** attempt * 500);
        }
      }
      throw lastError;
    },

    /** Standalone liveness check for the configured model IDs. */
    async checkModels(models = [config.models.primary, config.models.crossCheck]) {
      if (!configured) throw new VisionError('Workers AI is not configured');
      const results = [];
      for (const model of models) {
        const url = `${BASE(accountId)}/models/search?search=${encodeURIComponent(model.split('/').pop())}`;
        const response = await fetchImpl(url, {
          headers: { authorization: `Bearer ${apiToken}` },
          signal: AbortSignal.timeout(timeoutMs)
        });
        const payload = await response.json().catch(() => null);
        const found = ((payload && payload.result) || []).some(entry => entry.name === model);
        results.push({ model, available: found, status: response.status });
      }
      return results;
    }
  };
}

module.exports = { createVisionClient, VisionError, adapters, adapterFor, BASE, looksRetired };
