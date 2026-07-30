# Golden ID prototype

A local prototype that reads identity documents, compares them field by field, and — when the evidence supports it — issues a signed "Golden ID".

**It does not verify documents with UIDAI, Income Tax/Protean, ECI, DigiLocker, or any government system, and must not be presented as a government credential.**

## Run

Requires **Node.js 22+** (for `node:sqlite`). Developed on Node 24.

```sh
npm install
cp .env.example .env      # add CF_ACCOUNT_ID and CF_API_TOKEN
npm start                 # http://localhost:3000
npm test                  # 282 tests, fully offline
```

`npm run check:models` verifies the configured Workers AI model IDs are still live. `npm run check:models:smoke` additionally sends one real inference per model.

---

## Issuance is disabled by default

`ENABLE_ISSUANCE=false` ships as the default. Extraction, comparison and the full verdict report all work; minting a Golden ID does not. Turn it on deliberately, once you accept the three gates below hold in your deployment:

1. **Identity isolation** — the ownership chain is enforced and `test/isolation.test.js` passes with zero leakage.
2. **Capability enforcement** — `test/capability.test.js` passes, so no field a document cannot carry reaches consensus.
3. **Decision policy** — any integrity signal produces `blocked_security_integrity` and blocks issuance regardless of field agreement.

---

## What went wrong before, and what changed

This rebuild was driven by two failures that a fully-passing test suite did not catch.

### 1. Cross-applicant contamination

One applicant's PAN and Aadhaar appeared inside a *different* applicant's comparison, contributing to name agreement, DOB agreement, guardian comparison, face comparison and consensus. Two independent causes:

- The `extractions` table was keyed by file bytes alone, with **no user or application column anywhere**. Comparison took a list of content hashes straight from the request body and compared whatever they pointed at.
- The frontend held `selectedFiles` as a page-lifetime global cleared only on logout, so a second applicant inherited the first one's files.

**Both are fixed, independently.** There is now a full ownership chain:

```
users → applications → upload_batches → documents → logical_documents
                             │              ├─ face_embeddings
                             │              └─ corrections
                             └─ comparisons → records (gid)
```

Every query that touches identity data filters on it. A document is reachable **only** through the application that owns it — `getDocument(id, applicationId)` has no single-argument form. Referencing a foreign document is not silently ignored; it is an integrity failure that blocks issuance and is written to the audit trail. The frontend resets all state per application and has an explicit "Start a new application" action.

`extractions` deliberately sits **outside** the chain: it is byte-scoped compute, immutable, and carries no ownership. A cache hit reuses the extraction but always creates a fresh, owned `documents` row — so two applications can share the compute while a correction made by one is invisible to the other.

### 2. Hallucinated fields reaching the credential

The database contained a passport extraction carrying a `father_name`, a `mother_name` **and** an `address`. A passport bio page prints none of those — the holder's own name had been mapped into both parent slots, and the place of birth into the address. Worse, the comparison matrix listed the passport as a legitimate voter on parent names, so an invented value could become the consensus value on an issued credential.

**Fixed by a page-aware capability registry** (`lib/schemas/registry.js`), enforced at two points:

- The **prompt** only ever asks for fields that document and page can carry. A passport prompt has no `father_name` slot to fill.
- The **backend rejects** anything outside that set even if the model emits it anyway. The value is stored with `status: "invalid"` and a reason, so the hallucination stays auditable rather than vanishing — but it never reaches comparison or consensus.

The comparison matrix is now *derived* from that registry rather than maintained separately, which is what allowed the two to disagree in the first place.

---

## Architecture

```
server.js                 routing and HTTP only
lib/
  flags.js                feature flags; issuance master switch
  config.js               BOM-safe .env loader
  ratelimit.js            per-endpoint fixed-window limits
  application.js          the workflow; every method is application-scoped
  schemas/registry.js     country → document → page capability registry
  preprocess/             MIME sniffing, EXIF, quality gate, rotation, crops
  upload/
    discover.js           folder/ZIP/PDF expansion with safety limits
    grouping.js           front/back pairing that cannot merge two people
  extract/
    index.js              orchestrator: preprocess → deterministic → classify → vision
    vision.js             Workers AI REST client, two model adapters
    prompts.js            prompts GENERATED from the registry
    schema.js             evidence envelopes + capability enforcement
    classify.js           evidence-based type reconciliation
    tesseract.js          local OCR fallback
  validate/
    formats.js  checksums.js  repair.js  barcode.js
  normalize/              date, name, gender, structured address
  compare/
    names.js              multi-signal name matching
    cluster.js            evidence-weighted clustering
    decision.js           nine explicit decision states
    matrix.js  diff.js  levenshtein.js  index.js
  face/                   detect, embed, match, runtime
  record/                 consensus, dedup, Ed25519 issuance
  db/                     schema.sql + ownership-scoped data access
```

### Extraction order

1. **Preprocess** — sniff the MIME from the *bytes*, apply EXIF orientation, bound the size, measure quality. A blurred or glared scan becomes `retake_required` rather than a source of invented fields.
2. **Deterministic reads** — Aadhaar Secure QR and passport MRZ. These are machine-printed and checksummed; they are the closest thing to ground truth available without a government API.
3. **Classify** — the backend decides the document type from evidence.
4. **One vision call**, prompted with only that document's fields.
5. **Deterministic sources overwrite the model**, never the reverse.
6. **A second model** only when a required field is still missing or the classification is borderline.

### The backend decides what each document is

The model's `document_type` is one weighted vote. `lib/extract/classify.js` reconciles it against, in descending order of trust: a decoded Aadhaar QR or valid MRZ (conclusive) → the document number's format and checksum → which fields the card carries → what the model said.

This is not hypothetical. On a real Aadhaar card, Moondream returned `document_type: "pan"` while extracting a Verhoeff-valid 12-digit Aadhaar number, a gender, and no father's name — three facts each incompatible with a PAN. The classifier corrects it and records why:

> Reclassified from pan to aadhaar: Number is 12 digits and passes the Verhoeff checksum; Number does not fit the PAN format (wrong_length); A PAN card does not print a gender

When the top two candidates are close it returns `needs_confirmation` rather than guessing. A holder dropdown overrules both the model and the backend.

### Comparison

Names use **several independent signals**, not one score: token-set alignment (order-insensitive), Damerau-Levenshtein, Jaro-Winkler, a phonetic key for Indic transliteration, glued-form comparison, initial expansion, and surname-initial detection. Each difference is classified as:

- **safe variant** — case, spacing, word order, honorifics, abbreviation expansion. Normalised silently.
- **needs confirmation** — one or two characters, a dropped middle name, or a surname-initial relationship (`MUHAMMED MISHAB SALEEM P` vs surname `PARATHODI`). Plausible, but *inferred*, so the holder confirms it.
- **different** — genuinely not the same name.

**A single low-confidence OCR read never hard-rejects an applicant.**

Clustering weights by **evidence quality**, not headcount: a value from a UIDAI QR or a checksummed MRZ outranks two guesses from a vision model. A document that cannot carry a field **abstains** — counted as neither agreement nor disagreement, and shown as such in the UI.

### Decision states

`verified_match` · `likely_match_needs_confirmation` · `insufficient_evidence` · `extraction_failed` · `document_conflict` · `suspected_cross_identity` · `rejected_invalid_document` · `blocked_security_integrity` · `retake_required`

Only `verified_match` permits issuance. At least **two independent documents** must agree on name and date of birth. Integrity failures are terminal and cannot be confirmed past.

### Face matching is advisory, and uncalibrated

Four of five documents carry a photo, and text agreement does not prove one person holds all the cards. But card portraits are printed, low-resolution and sometimes decades old.

- Orientation is applied **server-side** before detection, and the other three rotations are tried if the upright read finds nothing. (A missing EXIF rotation was the likely cause of a genuine pair scoring 0.19.)
- Crops too small or too soft report `insufficient_quality` rather than a misleading number.
- **A face mismatch is a warning and never blocks a Golden ID.** A false reject here is far more damaging than a missed match.

The default `FACE_MATCH_THRESHOLD=0.5` is a **guess**. Run `node scripts/face-benchmark.js <samples>` over labelled pairs before treating the score as evidence. One real pair measured 0.65 — that is one pair, not a calibration.

---

## Uploads

Individual files, multi-select, folder selection, drag-and-drop folders, ZIP archives and multi-page PDFs. Each discovered file becomes its own document with its own ID, processed independently — a folder is never sent to one model prompt.

Guards: ZIP-slip (entries escaping the root), decompression bombs (>100:1 ratio), nested archives, symlinks, executables disguised by extension, and limits of 50 files / 200 MB expanded / 25 MB per file. **The MIME type comes from the bytes, never the filename.**

Front/back pages group only on positive evidence — a shared document number, a matching holder name, or the same source PDF. Ambiguous pages are kept separate: wrongly splitting one card is harmless, wrongly merging two people is not.

---

## Verified against the Workers AI API

- `@cf/moondream/moondream3.1-9B-A2B` — `stream` **defaults to true**, and a streaming request returns `{"result":{}}` over REST: HTTP 200, `success: true`, no content. The adapter sends `stream: false`.
- Its payload is **double-nested** as `result.result.answer`, which the published schema does not show.
- Even so it **intermittently** returns an empty result for an image that reads fine on retry, so empty responses are treated as retryable.
- `@cf/meta/llama-3.2-11b-vision-instruct` requires a **one-time licence acceptance** per account. Until accepted every call returns 403; the error explains exactly how to accept it.

---

## Security

Ownership enforced on every route · rate limiting on OTP, extraction, comparison and retrieval · the demo OTP echoed only when `EXPOSE_DEMO_OTP=true` · document numbers masked in transit and never embedded whole in a signed record · source scans deleted once extraction and the face embedding are cached, with a TTL sweep for the rest · Ed25519 signing keys stored outside the repository · short-lived scoped share tokens with single-use support · every issuance, retrieval, correction, denial and integrity block written to an audit table.

**Not yet done, and required before this touches real data:** encryption at rest (SQLite and `.uploads/` are plaintext), TLS termination, a real OTP delivery provider, and a data-deletion path that also revokes derived Golden IDs.

---

## Testing

```sh
npm test
```

282 tests, entirely offline — all model calls are mocked. The suites that matter most are the ones that did not exist before:

- **`isolation.test.js`** — two users, two applications, concurrent operation, the exact reported reproduction, foreign-document references, and cache sharing without ownership sharing. **Acceptable result is zero leakage.**
- **`capability.test.js`** — a passport emitting parents or an address is rejected end to end and cannot reach consensus.
- **`upload.test.js`** — ZIP-slip, bombs, nested archives, symlinks, misleading extensions, limits, and page grouping that refuses to merge two people.

Face tests use synthetic vectors deliberately: they prove the cosine maths and nothing about real photographs. `scripts/face-benchmark.js` exists precisely because synthetic similarity is not evidence.

---

## Known limitations

- Indic OCR fidelity is unproven. Workers AI has no dedicated OCR model, and the local Tesseract fallback runs `eng+hin` only — **Malayalam and other regional scripts are not covered.**
- Vision-only reads carry no bounding boxes, so `evidence_text` and `bounding_box` are populated only for MRZ and QR sources. Full positional evidence needs a local OCR engine (PP-OCRv5 or similar).
- The Aadhaar QR's UIDAI signature is **parsed but not verified** — that needs UIDAI's public certificate, which is deliberately not bundled. A decoded QR is strong evidence, not government verification.
- Face thresholds are uncalibrated against real document photographs.
- Storing and comparing Aadhaar numbers has regulatory implications in India. Get that reviewed before any non-prototype use.
- This is a prototype. It is not a Government of India credential and cannot verify against any government system.
