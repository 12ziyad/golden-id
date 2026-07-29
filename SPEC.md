# Golden ID — Extraction & Verification Rebuild

> Implementation spec for the v2 rebuild. Kept in the repo for reference.
> See `README.md` for how the delivered system actually behaves, including
> several places where the live Workers AI API differed from its documentation.

## Context

This is `one_id`, a Node.js prototype that reads Indian identity documents (Birth Certificate, Aadhaar, PAN, Passport, Voter ID), extracts identity fields, and cross-compares them to issue a "Golden ID" only when the shared details agree.

The v1 implementation used `tesseract.js` OCR followed by regex field-picking, and compared documents with plain string equality. Both layers were unreliable and have been replaced.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Runtime | Keep the Node HTTP server. Call Cloudflare Workers AI over REST. |
| Storage | Local SQLite (`node:sqlite`, Node 22+). Bump `engines` to `>=22`. |
| Scope | Text extraction + comparison **and** face matching across document photos. |

## Known bugs that had to be fixed

1. **Father's name captured as the holder's name.** `extractDocumentText`'s fallback took `candidates.at(-1)` — the last clean text line above the DOB line. On every PAN card that is the father's name.
2. **Blank counted as a mismatch.** `compareDocuments` built a `Set` of values; `["", "12 MG ROAD"]` has size 2 so it rejected. PAN has no address, Aadhaar does → automatic false rejection. Same for gender, which PAN does not print.
3. **No date normalization.** `12/08/1997`, `12-08-1997` and `1997-08-12` were three different values.
4. **No gender normalization.** `M` vs `MALE` rejected.
5. **Name order variation rejected.** `MUHAMMED SAKIR K` vs `K MUHAMMED SAKIR` is a legitimate ordering difference across Indian IDs.
6. **Three OCR passes merged as concatenated text.** `readUploadedFile` scored each pass by field count, then discarded that and joined all three raw texts, so the regexes ran over interleaved output from three different page-segmentation modes.
7. **Every file OCR'd twice.** `/documents/identify` fired on every file add and on the consent checkbox; `/compare-files` then re-read everything. Five documents × three passes × two endpoints ≈ 30 sequential OCR runs per application. Nothing was cached.
8. **Golden record copied `documents[0]`** — an arbitrary document — rather than the consensus value.
9. **Date regex required a four-digit year**, so `12/08/97` yielded nothing.
10. **English-only traineddata** against cards that print bilingual Hindi/English labels.

## Target file structure

```
server.js                    routes and HTTP only
lib/
  extract/    index.js vision.js prompts.js schema.js tesseract.js
  validate/   formats.js checksums.js repair.js
  normalize/  date.js name.js gender.js address.js
  compare/    matrix.js levenshtein.js cluster.js diff.js index.js
  face/       detect.js embed.js match.js
  record/     consensus.js dedup.js issue.js
  db/         schema.sql index.js
public/       app.js index.html verify.html styles.css workflow.css
test/         fixtures/ *.test.js
```

## 1. Extraction layer

### 1.1 Workers AI REST client (`lib/extract/vision.js`)

Call Cloudflare Workers AI from Node over HTTPS. No SDK — use `fetch`.

- Base: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/`
- Auth header: `Authorization: Bearer {API_TOKEN}`
- Prefer the OpenAI-compatible path `ai/v1/chat/completions` for chat-style vision models, passing the image as a data URI in an `image_url` content block.
- Some models expect the native `ai/run/{model}` path with a different body shape.

**Build a small adapter per model rather than assuming one request shape.** Verify each model's expected input against the current Cloudflare Workers AI docs before finalising — the catalog and schemas change frequently. If a model ID has been retired, fail loudly with a clear message rather than silently degrading.

| Role | Model ID |
|---|---|
| Primary | `@cf/moondream/moondream3.1-9B-A2B` |
| Cross-check | `@cf/meta/llama-3.2-11b-vision-instruct` |
| Fallback | local Tesseract |

Requirements: 15s timeout per call, 2 retries with exponential backoff, fall through to Tesseract marked `source: 'tesseract-fallback'`, and never let a single document failure abort the whole batch.

### 1.2 Prompts (`lib/extract/prompts.js`)

One prompt per document type, plus a generic one. The prompt must demand JSON only (no prose, no fences); request `father_name` and `mother_name` as **separate named fields** (this is what stops the model folding a parent's name into `name`); instruct `null` for absent fields and explicitly forbid guessing; require values transcribed exactly as printed including spacing and initials; and ask for the date exactly as printed, without reformatting.

Required output shape:

```json
{
  "document_type": "pan|aadhaar|passport|voter|birth_certificate|unknown",
  "name": "string|null", "father_name": "string|null", "mother_name": "string|null",
  "spouse_name": "string|null", "dob": "string|null", "gender": "string|null",
  "address": "string|null", "document_number": "string|null",
  "issue_date": "string|null", "expiry_date": "string|null"
}
```

Validate against this shape in `schema.js`. Strip markdown fences defensively before parsing. If parsing fails twice, treat it as a model failure and fall through.

### 1.3 Orchestrator (`lib/extract/index.js`)

- **Cache by content hash.** SHA-256 the file bytes; key extraction results by that hash in SQLite. Never extract the same bytes twice, including across the identify and compare endpoints.
- **Run all documents in parallel.** Delete the global `ocrQueue` serialisation. Cap concurrency at 5.
- **Run both vision models per document**, then merge per field: both agree → `high`; only one returned a value → `medium`; they disagree → keep both, `low`, flag for confirmation.
- Return per-field confidence, not one page-level number.
- Config flag to run the cross-check model only when the primary is low-confidence or null on a required field.

## 2. Validation layer

### 2.1 Formats

| Document | Pattern |
|---|---|
| PAN | `^[A-Z]{5}[0-9]{4}[A-Z]$` |
| Aadhaar | 12 digits, first digit not 0 or 1, Verhoeff-valid |
| Passport | `^[A-Z][0-9]{7}$` |
| Voter ID (EPIC) | `^[A-Z]{3}[0-9]{7}$` |
| Birth certificate | no national format — accept, do not validate |

### 2.2 Checksums

**Verhoeff** for Aadhaar, with its `d`, `p` and `inv` tables. A 12-digit read that fails Verhoeff is a misread, not a fake card. **MRZ check digits** for passports when present — the MRZ is the most reliable region on a passport, so parse it in preference to the visual zone and use it to cross-check name, DOB, sex and number.

### 2.3 Repair

Positional character repair using the known format. In a PAN, positions 1–5 and 10 must be alphabetic and 6–9 numeric, so in alpha slots `0→O`, `1→I`, `5→S`, `8→B`, `2→Z`, and the inverse in numeric slots. Retry validation after repair; if it passes record `repaired: true` and surface it; if not, mark the field for manual entry.

**Document numbers are never compared across documents** — each card has its own. They are validated individually only.

## 3. Normalization layer

- **`date.js`** — parse `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`, `YYYY-MM-DD`, `DD MMM YYYY`, and two-digit years, to ISO `YYYY-MM-DD`. Sane pivot for two-digit years. Keep the original alongside the normalized value. Return `null` on genuinely ambiguous input rather than guessing between DD/MM and MM/DD — Indian documents are DD/MM, so default to that but flag the ambiguous case.
- **`gender.js`** — `M`, `MALE`, `पुरुष` → `M`; `F`, `FEMALE`, `महिला` → `F`; else `O`.
- **`name.js`** — uppercase, strip punctuation and honorifics, collapse whitespace, produce both an ordered form and a sorted token set. Expand common abbreviations (`MD` → `MUHAMMED`) as an *alternate* candidate, never a replacement.
- **`address.js`** — light cleanup only. Addresses are never used for rejection.

## 4. Comparison layer

### 4.1 Field matrix

Only compare a field across documents that actually carry it. Missing where expected is "could not extract". Missing where not expected is ignored entirely.

| Field | Birth Cert | Aadhaar | PAN | Passport | Voter ID |
|---|---|---|---|---|---|
| name | yes | yes | yes | yes | yes |
| dob | yes | yes | yes | yes | partial |
| gender | yes | yes | no | yes | yes |
| father_name | yes | no | yes | yes | father or husband |
| mother_name | yes | no | newer cards only | yes | no |
| address | no | yes | no | back page | yes |
| document_number | yes | yes | yes | yes | yes |

Voter ID may print a husband's name instead of a father's name for married women — treat `father_name` and `spouse_name` as one comparison group, and do not reject on the distinction.

### 4.2 Clustering

**Delete the `Set(...).size > 1` logic entirely.** For each field, take every document expected to have it, then: normalize each value; group exact matches; merge groups whose representatives are within Levenshtein distance ≤ 2 (per token for names), marking the merge as `likely_ocr_variant`; identify the majority cluster and the dissenters.

```json
{
  "field": "name", "value": "MUHAMMED SAKIR K",
  "agreeing": ["aadhaar", "pan", "passport", "birth_certificate"],
  "dissenting": [{ "type": "voter", "value": "MUHAMMAD SAKIR K",
      "distance": 1, "diff": "MUHAMM[E→A]D SAKIR K" }],
  "confidence": 0.8, "severity": "reject"
}
```

For names, compare token-sorted sets first so ordering differences do not register as mismatches, then compare tokens pairwise for the diff.

### 4.3 Severity

| Field | Mismatch severity |
|---|---|
| name | **reject** |
| dob | **reject** |
| gender | **reject** |
| father_name / mother_name / spouse_name | **warn** |
| address | **info** — never blocks |
| face match | **warn** (see §5) |

Levenshtein distance 1–2 on name or DOB → `needs_confirmation`, not an outright reject.

## 5. Face matching

Four of the five documents carry a photo. Text agreement proves the *names* match; it does not prove one person holds all the cards. `detect.js` locates and crops face regions, `embed.js` produces embeddings, `match.js` does pairwise cosine similarity.

Workers AI has no face-recognition model, so this runs locally in Node using `@vladmandic/human` (not the unmaintained `face-api.js`).

**Constraints:**

- ID card photos are low-resolution, printed, often monochrome and decades old. Similarity scores will be noisy.
- Set the cosine threshold conservatively and make it configurable. Start around `0.5` and document that it needs tuning against real samples.
- **Face mismatch is a `warn`, never an automatic reject.** A false reject here is far more damaging than a missed match.
- No face detected is not a failure — record `face: null` and exclude it from comparison.
- Handle the case where only one photo is available.

## 6. Golden record

**Consensus** — delete the `documents[0]` copying. Build each field from the majority cluster, retaining provenance (`value`, `sources`, `dissenting`, `confidence`).

**Dedup** — before minting, check SQLite for a hash of `normalized_name + dob + gender` and for each individual document number. If either already maps to a Golden ID, return the existing one. A system called "one ID" that issues unlimited IDs per person is meaningless.

**Issuance** — replace the bare random string with a signed credential: Ed25519 keypair generated at first run, private key persisted outside the repo, public key at `/api/v1/.well-known/golden-id-key`. Sign the canonical JSON and store the signature. Keep the `GID-` prefix for display, but a verifier should check the signature. Add `revoked` / `revoked_at` and honour them on retrieval. Replace the permanent bearer token with **short-lived, scoped share tokens** (field scope, TTL, optional single-use). Log every retrieval to an audit table.

## 7. Database

`node:sqlite` (Node 22+). Tables: `extractions`, `applications`, `records`, `document_numbers`, `share_tokens`, `audit`. Index `extractions.content_hash`, `records.dedup_hash`, `document_numbers.number`. Store uploaded images under `.uploads/` with a TTL sweep, and delete the source scan once extraction is cached. Add `.uploads/` and the key file to `.gitignore`.

## 8. Endpoints

| Method | Path | Change |
|---|---|---|
| POST | `/api/v1/documents/extract` | Replaces `/documents/identify` |
| POST | `/api/v1/applications/compare-files` | Reads from cache. Must not re-extract |
| PATCH | `/api/v1/documents/:hash/field` | New. Manual override of a single field |
| GET | `/api/v1/applications/:id/verdict` | New. Full report |
| POST | `/api/v1/records/:gid/share` | New. Mint a scoped, expiring share token |
| GET | `/api/v1/cards/:gid` | Accept share tokens with scope enforcement; log to audit |
| GET | `/api/v1/.well-known/golden-id-key` | New. Public key |

Keep OTP auth and the consent gates exactly as they are. Consent remains mandatory before any extraction.

## 9. Frontend

Per-document progress indicators running in parallel, not one shared spinner. Replace the flat error list with a **field-by-field verdict table**: field, agreed value, which documents agree, which dissent, the diff. Render character-level diffs visibly (`MUHAMM[E→A]D`). Per-field "fix this" input inline, so a single unreadable DOB does not force re-entry of all five documents. Severity colouring: red reject, amber warn, grey info. Show face-match results as an advisory panel, clearly labelled as indicative. Keep the existing visual design language — do not restyle the app.

## 10. Tests

The v1 suite asserted the buggy behaviour and was rewritten. Required coverage: date normalization across every listed format including two-digit years; gender normalization including bilingual values; name token-set matching, ordering variation and single-character diff reporting; field matrix (PAN missing address does **not** mismatch against Aadhaar); Verhoeff accept and reject; PAN positional repair; clustering 4-agree-1-dissent; consensus record provenance; dedup returning the existing GID; cache extracting exactly once per hash; schema validation rejecting malformed model output; fixtures for each of the five document types, including a PAN with a father's name present which must **not** be picked up as `name`.

Mock the Workers AI calls. Do not hit the network in the test suite.

## 11. Config

`.env` with `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `PORT`, `FACE_MATCH_THRESHOLD`, `CROSS_CHECK_MODE`. `.env.example` committed, `.env` gitignored. Update `README.md`. Keep the existing "not a government credential" disclaimers everywhere — they are accurate and must stay.

## Explicitly out of scope

- Embeddings or vector search for field comparison. Semantic similarity would score `MUHAMMED` and `MUHAMMAD` as near-identical, which defeats the purpose. Comparison stays deterministic.
- Any government API integration (UIDAI, Protean, ECI, DigiLocker).
- QR generation.
- Changing the visual design.

## Build order

1. `normalize/` + `compare/` + tests — pure logic, no network, fixes the false rejections immediately
2. `validate/` + checksums + repair
3. SQLite layer + extraction cache
4. `extract/vision.js` + prompts, with Tesseract retained as fallback
5. `record/` — consensus, dedup, signing
6. `face/`
7. Frontend rewrite
8. Endpoints and README

Run the test suite after each stage. Do not proceed with failing tests.
