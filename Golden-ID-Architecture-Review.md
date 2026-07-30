# Golden ID — Architecture Review & Rebuild Plan

**Prepared for:** Kayote Network
**Scope:** `C:\Users\ziyad\Downloads\one id\one id`
**Date:** 29 July 2026
**Status:** Review only. No repository changes have been made. Coding is not to begin until you approve the plan.

> **Reading guide.** Findings I could confirm directly from the code or the live database are marked **[CONFIRMED]** with file/function/line references. Things I infer but could not prove from the artefacts alone are marked **[HYPOTHESIS]**. Model IDs and prices were verified against official Cloudflare / vendor documentation on 29 Jul 2026 and are marked **[VERIFIED <date>]**; anything I could not confirm is marked **[UNVERIFIED]**.

> **One correction up front.** The brief describes several problems (misclassification trusting the model, `documents[0]` consensus, blank-as-mismatch, glued names) as if they were still live. Reading the code, **most of these have already been fixed** in the current tree — there is an evidence-based classifier, a consensus builder, a field matrix, and glued-name handling. I have said so where it applies rather than re-reporting fixed bugs as open. The genuinely dangerous, still-open problems are narrower and I have concentrated on those: **identity isolation, hallucinated field mapping into consensus, the passport capability row, cache provenance, and the face pipeline.**

---

## Table of contents

1. Exact problems found in the current repository
2. Root-cause hypotheses, ranked by evidence
3. Three architecture alternatives
4. Recommended architecture
5. Cloudflare models selected, and why
6. Whether local / specialised OCR is required
7. Model-call flow
8. Data-flow diagram
9. Database schema changes
10. Upload / folder / ZIP design
11. Extraction schema
12. Document capability matrix
13. Comparison algorithm
14. Decision policy
15. Face strategy
16. Cache design
17. Security controls
18. Testing & benchmark plan
19. Migration steps
20. Cost & latency estimate
21. Risks & remaining limitations
22. Phased implementation plan
23. Acceptance criteria per stage
24. Rollback plan
25. Questions that genuinely need your decision

Plus: minimum-safe-prototype vs production plans; what to disable; the exact point at which issuance may be re-enabled.

---

## 1. Exact problems found in the current repository

### 1.1 Identity isolation is not implemented at all — **[CONFIRMED]** — *critical*

There is no ownership model anywhere below the session. The word "leak" undersells it: the extraction store is a single global pool keyed only by file bytes, and comparison operates on whatever hashes the client posts.

Concrete evidence:

- **`lib/db/schema.sql:10-26`** — the `extractions` table is keyed by `content_hash TEXT PRIMARY KEY` with **no `user_id`, no `application_id`, no `session_identifier`** column. Every extraction any user has ever produced lives in one flat namespace.
- **`lib/application.js:96-99`** — `compare(hashes)` does `hashes.map(hash => store.getExtraction(hash)).filter(Boolean)`. It never checks that those hashes belong to the caller. Any authenticated session can compare any hash in the database.
- **`server.js:152-171`** — the `/compare-files` route reads `body.hashes` straight from the request and passes them to `compare()`. The only server-side value used is `session.identifier`, which is written into `applications.session_identifier` but **never used as a filter** on anything.
- **`lib/db/index.js:60-86`** — `getExtraction(hash)` has no ownership parameter and cannot enforce one; the row has nothing to enforce against.

**Live-database proof of missing isolation (`golden-id.sqlite`, read read-only):**

- Applications `14735cf7` (session `shak…`) and `4de7642a` / `caecd062` (session `9345…`) all resolve to **the same** `GID-F5B95AA5B893`. Different sessions are operating over the same global identity pool.
- The `extractions` table holds documents from at least two distinct people simultaneously — files named `SHAKIR PAN.jpg` / `SHAKIR ADHAR.jpg` alongside `IMG_4744.jpeg` / `IMG_0285.jpeg` (a different applicant, "Mishab") — with **no column that separates them**.

This is the Sakir→Mishab contamination. It is a data-integrity and security defect, not an OCR defect, and it is caused by two independent mechanisms — see §1.2 and §1.3.

### 1.2 Frontend accumulates documents across applicants — **[CONFIRMED]** — *critical, primary cause of the observed symptom*

- **`public/app.js:132-133`** — `selectedFiles` (an array) and `extracted` (a `Map`) are **module-level globals** for the whole page lifetime.
- They are cleared in exactly one place: the **logout** handler (**`app.js:67-84`**, `selectedFiles = []; extracted.clear()`).
- There is **no "start a new application" action**. `showUploadStage()` (`app.js:58-64`) and "← Add document" (`addFromCompare`, `app.js:65`) do **not** clear them.
- **`runComparison()` (`app.js:415-425`)** builds the comparison set from **every** file still in `selectedFiles`: `selectedFiles.map(file => extracted.get(fileKey(file))) … .map(item => item.hash)`.

So the workflow that produces the exact reported symptom is: operator uploads Sakir's PAN + Aadhaar (+ others), issues, then — **without logging out** — adds Mishab's Passport + Voter ID. `selectedFiles` now contains Sakir's *and* Mishab's files, and `runComparison` sends all their hashes. Sakir's PAN and Aadhaar then participate in name agreement, DOB agreement, guardian comparison, face comparison and consensus — precisely as observed.

Aggravating: the UI copy claims **"Selected files never leave your browser"** (`index.html:9`) and **"Selected files never leave your browser. This prototype does not read or authenticate real documents."** This is false — `extractPending()` (`app.js:221-224`) posts the files as data URIs to `/documents/extract`. Real identity documents are being uploaded to the server despite an on-screen promise that they are not.

### 1.3 Backend has no session→hash ownership check — **[CONFIRMED]** — *critical, second independent cause*

Even with the frontend fixed, the backend would still let one user pull another's document into a comparison, because the extraction cache is global and `compare()` trusts client-supplied hashes (§1.1). A malicious or buggy client posting a hash it does not own gets that document's fields, face embedding and number suffix back in the verdict payload (`server.js:176-185`, `lib/application.js:152-168`). **Two independent bugs both have to be fixed; fixing only the frontend leaves an IDOR-class hole.**

### 1.4 Hallucinated field mapping reaches the consensus record — **[CONFIRMED]** — *critical*

The live DB contains the smoking gun. The passport extraction row (`024c05c464`, `IMG_0285.jpeg`, type `passport`) has:

- `name` ≈ 25 chars starting "MU…"
- `father_name` ≈ 16 chars starting "MU…"
- `mother_name` ≈ 25 chars starting "MU…" (same length as `name`)
- `address` populated, ≈ 20 chars starting "PA…" (almost certainly **place of birth / surname "PARATHODI"**, not a residential address)

A passport bio page prints **none** of father/mother/spouse/residential-address. These are hallucinations or mis-mapped fields (holder name → parent name; place of birth → address), exactly the failure class the brief lists. Two design gaps let them through:

1. **Extraction schema is not per-document.** `lib/extract/schema.js` (`FIELDS`, `validateExtraction`) applies the **same 11-field shape to every document type**. There is no rule that says "a passport may not emit `father_name`." Whatever the model returns is accepted and stored.
2. **The comparison matrix actively invites it.** `lib/compare/matrix.js:28-39` sets `father_name: passport 'yes'` and `mother_name: passport 'yes'`. So not only is the hallucinated value stored, the matrix treats the passport as a **legitimate voter** on parent names. Because `guardian_name` and `mother_name` are in `RECORD_FIELDS` (`lib/record/consensus.js:14`), a hallucinated passport parent name is clustered and **can become the consensus value on the issued Golden ID.**

This is the most direct path from "model made something up" to "the credential now asserts it."

### 1.5 Passport capability row is wrong — **[CONFIRMED]** — *high*

Related to 1.4 but worth separating. `matrix.js` treats a passport as carrying `father_name`, `mother_name`, `gender`, `dob`, `address (partial)`. On an Indian passport **bio/data page** (the front, which is what people scan): parents and spouse are on the **back page**, and there is **no residential address** (only place of birth). The current matrix therefore lets a front-page passport abstain on nothing and vote on fields it cannot see. The correct model needs **page-level** capabilities (bio page vs back page), not one row per document type.

### 1.6 Classification is evidence-based but has no `needs_confirmation` and depends on a correct number — **[CONFIRMED]** — *medium (largely fixed)*

`lib/extract/classify.js` is genuinely good: it treats the model's `document_type` as one weighted vote against number-format, checksum and field-presence evidence, and the DB shows it working (`SHAKIR ADHAR.jpg` model-claimed `pan`, corrected to `aadhaar`; passport model-claimed `pan`, corrected to `passport`). **Problem #2 in the brief is substantially resolved.** Residual issues:

- It always resolves to a concrete type when `best.score > 0`; there is **no `needs_confirmation` outcome** when the top two types are within a small margin. A close call silently picks the winner (`classify.js:139-158`).
- Its strongest signal is the document number (`WEIGHTS.numberFormat = 5`). If OCR misreads the number, the strongest evidence is corrupted and classification can still go wrong. There is no QR/MRZ cross-check feeding classification.
- `inferType` in `formats.js:92-99` checks PAN/passport/voter patterns **before** Aadhaar. A 10-char string that happens to match PAN wins even if the card is something else — order-dependence that is fine today but brittle as types grow.

### 1.7 Cache has no provenance and mixes immutable extraction with mutable state — **[CONFIRMED]** — *high*

- **Cache key is `SHA-256(file bytes)` only** (`lib/db/index.js:19-21`, `lib/uploads.js:43-48`). It does **not** include extractor, prompt version, schema version or model IDs. Change the prompt or swap the model and every previously-seen file silently returns the **old** extraction (`lib/extract/index.js:135-139` returns the cached row before any model runs). The SPEC explicitly asked for the key to include these; it was not done.
- **The extraction row also stores `overrides`, `face`, and `classification`** in the same row keyed by bytes (`schema.sql:19-20`). So the cache is not "the extraction of one exact file" — it is a mutable per-file record. If two different applications ever upload byte-identical files, a manual override or cached face made by one is visible to the other. Rare across genuinely different people, but a real design violation of "the cache must contain only the extraction for one exact file."
- There is no separation between **raw model output** and **holder corrections** at rest beyond an `overrides` blob merged on read (`db/index.js:73-74`). Raw is preserved, which is good, but corrections are not attributed to a user or application.

### 1.8 Face pipeline: no EXIF orientation, detector rotation disabled, uncalibrated threshold — **[CONFIRMED]** — *high (explains the 0.19)*

- **`public/app.js:136-149` (`prepareImage`)** draws the image through a canvas via `createImageBitmap(file)` **without** `{ imageOrientation: 'from-image' }` and without reading EXIF. A phone photo with an orientation tag is re-encoded **still rotated**. The server never sees the intended orientation.
- **`lib/face/runtime.js:102`** configures the detector with `rotation: false`. A rotated portrait is not rotation-corrected before detection.
- **`lib/face/detect.js:69-74`** builds the tensor from raw decoded RGB (0–255) as `float32` with no resize/normalisation/alignment beyond what `@vladmandic/human`'s `faceres` does internally, and picks the highest-confidence face with no crop-quality gate.
- **Threshold `0.5` is an explicit guess** (`lib/config.js:85`, `lib/face/match.js:98` even says so). ID-card portraits are tiny, printed, sometimes monochrome. A genuine pair scoring **0.19** is fully consistent with: rotated passport + no EXIF + whole-card-or-misaligned crop + untuned threshold. The pipeline is advisory-only and never blocks (correct), but its numbers are currently meaningless.
- Because face inputs are built from the posted hashes (`lib/application.js:111-116`), the frontend-accumulation bug (§1.2) **also** pulls another applicant's face into the comparison.

### 1.9 Text extraction quality issues — **[CONFIRMED via design]** — *medium*

- **Two-model merge is shallow.** `mergeReadings` (`lib/extract/index.js:52-91`) compares fields by upper-cased exact string. `MUHAMMED SAKIR K` vs `MUHAMMEDSAKIR K` are "disagreement → low confidence, keep both," not recognised as the same value at extraction time (that reconciliation only happens later in `compare/`). Fine, but it means per-field confidence at extraction is noisier than it looks.
- **No OCR bounding boxes / evidence coordinates.** Neither the Moondream nor the Llama path returns positions, so the "evidence_text / bounding_box" requirement in the brief cannot be satisfied by the current vision path (see §5, §11).
- **Tesseract fallback still positionally guesses the Aadhaar name** (`lib/extract/tesseract.js:199-210`) — scoped to Aadhaar only, but it is exactly the "last clean line above DOB" heuristic that caused the original PAN father-name bug, now fenced to a type that carries no parent name. Acceptable, but fragile.
- **Empty/rotated handling** relies on retrying the vision call (`lib/extract/vision.js:208-217`), which helps intermittent blanks but does nothing for a genuinely rotated or low-quality image — there is **no image-quality gate**, so a bad scan produces hallucinated fields instead of a "retake" request.

### 1.10 No preprocessing pipeline — **[CONFIRMED]** — *high*

There is **no** server-side MIME-sniffing, EXIF-orientation, deskew, perspective-correction, blur/glare detection, resolution check, or PDF rasterisation. The only image handling is the browser canvas downscale (`app.js:136-149`) and a byte-based magic check inside the face decoder (`lib/face/detect.js:11-14`). MIME comes from the client-declared data-URI header (`lib/uploads.js:21-29`), which is trusted.

### 1.11 Upload is single/multi-file only — **[CONFIRMED]** — *medium (feature gap)*

`index.html:12` has `<input id="files" type="file" multiple accept="image/*,.pdf,.txt">`. That supports multi-select. There is **no** folder selection (`webkitdirectory`), **no** drag-and-drop, **no** ZIP handling, **no** PDF page-splitting (a multi-page PDF is sent as one data URI to a vision model that cannot page it), **no** front/back grouping, and a hard cap of **5 files** per batch (`server.js:125`, `server.js:167`).

### 1.12 Comparison-timing gate is weak — **[CONFIRMED]** — *medium*

`compareFiles.onclick` (`app.js:458-473`) does `await extractPending(); await runComparison();`. `runComparison` then filters to items that already have a `hash` and `status !== 'failed'`. There is no explicit "**all selected documents have reached a final state**" barrier — if an earlier extraction is still in-flight (a document in `reading`), it simply gets **silently excluded** from the comparison rather than blocking it. Comparison can therefore run on a subset without telling the user.

### 1.13 Tests assert component behaviour but never the failure that mattered — **[CONFIRMED]** — *high (process defect)*

The suite (137 `test(...)` cases across 10 files) is broad and mostly good, but it is **entirely offline and unit/integration-scoped with mocked models** (`test/*.test.js`; SPEC §10 "Do not hit the network"). Critically:

- **There is no test that two applications cannot see each other's documents.** `test/db.test.js` round-trips extractions by hash; nothing asserts ownership because there is no ownership to assert.
- **There is no test that a passport cannot contribute a father/mother/address.** `test/server.test.js:219` checks PAN-vs-Aadhaar address, but nothing forbids a passport hallucinating parents into consensus.
- **Face tests use synthetic vectors** (`test/face.test.js:19-47`) — they prove cosine maths, not that a real rotated passport photo matches a real voter photo. The brief's warning "do not use synthetic-face similarity as proof" is exactly what the suite currently does.
- Every model call is mocked, so **no test exercises a real Cloudflare response, a real image, or a real rotation.** This is why "tests pass" while live behaviour was unsafe.

### 1.14 Security / privacy gaps for real documents — **[CONFIRMED]** — *high*

- **Demo OTP returned in the API response** (`server.js:89`) and rendered on screen (`app.js:98`). Fine for a local demo, unacceptable the moment this is reachable over a tunnel.
- **No encryption at rest.** SQLite and `.uploads/` are plaintext on disk. Real Aadhaar/PAN/passport numbers, names, DOBs and **face embeddings** sit unencrypted (`schema.sql`, `lib/uploads.js`).
- **No rate limiting** on `/documents/extract` or `/compare-files`; body cap is 60 MB (`server.js:45`).
- **Logs**: `server.js` logs config on boot; document numbers are masked in API responses (`lib/application.js:25-28`) — good — but there is no structured redaction policy and errors can carry raw model text (`lib/extract/vision.js` `body: raw.slice(0,500)`).
- **Contaminated Golden IDs cannot be selectively invalidated** beyond manual `revoke`. `GID-F5B95AA5B893` in the live DB was built from a 2-document comparison and may itself be a contaminated artefact.

---

## 2. Root-cause hypotheses, ranked by evidence

| # | Root cause | Evidence strength | Basis |
|---|---|---|---|
| 1 | **No ownership dimension in the data model.** Extractions are keyed by bytes alone; comparison trusts client hashes. | **[CONFIRMED]** | `schema.sql:10-26`; `application.js:96-99`; live DB: cross-session shared GID |
| 2 | **Frontend never resets `selectedFiles`/`extracted` between applicants.** | **[CONFIRMED]** | `app.js:132-133`, `67-84`, `415-425`; matches exact symptom |
| 3 | **Per-document field constraints are absent at extraction and wrong in the matrix (passport).** Hallucinated parents/address reach consensus. | **[CONFIRMED]** | live passport row with parent+address values; `schema.js`; `matrix.js:28-43` |
| 4 | **Cache key omits prompt/model/schema version and mixes mutable state into the extraction row.** | **[CONFIRMED]** | `db/index.js:19-21,73-74`; `schema.sql:19-20` |
| 5 | **Face pipeline drops orientation and runs an uncalibrated threshold.** | **[CONFIRMED]** | `app.js:136-149`; `runtime.js:102`; `config.js:85` |
| 6 | **Classifier has no abstain state and leans on a possibly-misread number.** | **[CONFIRMED]** | `classify.js:127-158`; `formats.js:92-99` |
| 7 | **Tests never covered isolation, hallucination-into-consensus, or real faces.** | **[CONFIRMED]** | absence across `test/*` |

The two the brief worried might need "a stronger model" (isolation, field mapping) are **#1/#2 and #3** — all three are **deterministic/data-model** faults. As the brief's decision rules say, **a stronger model fixes none of them.**

---

## 3. Three architecture alternatives

Assume ~4 images per application. "Calls" = model/API invocations. Costs use **[VERIFIED 2026-07-29]** Cloudflare pricing (neurons at **$0.011 / 1,000**, free **10,000 neurons/day**) and per-model token prices; token counts for a vision call are estimated (image encoding ≈ several hundred–low-thousands of tokens plus a ~400-token prompt and ~300-token JSON reply), so treat cost figures as **order-of-magnitude**, not quotes.

### Architecture A — Cloudflare-only (vision models + Node libraries + deterministic validators)

Vision model reads each page → strict JSON → deterministic validators (Verhoeff, MRZ, PAN/EPIC regex) → evidence-based classifier → comparison. Local Node libs for non-AI work: `sharp` (EXIF/resize), `@hyzyla/pdfium` (PDF raster), `mrz` (MRZ), `zxing-wasm` (QR). Face stays local (`@vladmandic/human`); **Workers AI has no face model** **[VERIFIED]**.

- **Accuracy potential:** medium-high on clear English cards; **variable on exact character transcription** and Indic scripts — no Workers AI model documents Hindi/Malayalam OCR fidelity **[VERIFIED: UNVERIFIED upstream]**.
- **Hallucination risk:** medium — mitigated by strict per-doc schema + validators, but a VLM can still invent a plausible number/name; no bounding-box evidence to ground it.
- **Latency:** ~1–4 s per page per model over REST.
- **Privacy:** images leave the machine to Cloudflare. One vendor, one DPA.
- **Complexity:** low-medium (closest to today).
- **Cost / 1,000 apps:** 1 model/page × 4 pages = 4,000 calls; with a conditional cross-check on ~25% and one reclassify pass on ~15%, ≈ 5,600 calls. On a cheap vision model (e.g. Gemma-4 at **$0.10/M in, $0.30/M out [VERIFIED]**) this is well **under ~$10–25** for 1,000 apps — dominated by per-call overhead, not tokens.
- **Model calls:** ~4–6 per app.
- **Ops:** Cloudflare account, licence acceptance for gated models, model-liveness monitoring (catalog churns — see §5).
- **Pros:** simplest, cheapest, single vendor, already 80% built. **Cons:** exact-text accuracy and Indic OCR are the weakest link; no positional evidence; face still local.

### Architecture B — Cloudflare + local/open-source OCR (recommended for the prototype)

Deterministic local **OCR does the exact reading** (text + boxes + confidence); a Cloudflare **VLM does semantic mapping and disagreement-resolution only**; deterministic validators + QR/MRZ are the final authority.

- Local: **PP-OCRv5 via ONNX (`ppu-paddle-ocr`, Node)** primary, **tesseract.js (`eng+hin`, add `mal`)** fallback **[VERIFIED]**; `mrz` npm; `zxing-wasm` for Aadhaar Secure QR (signed payload carries name/DOB/gender/address/photo — a **ground-truth source** when present) **[VERIFIED]**; `sharp` + `opencv-wasm` for preprocessing; `@hyzyla/pdfium` for PDF.
- Cloudflare VLM: called **once per page** to map OCR tokens → typed fields with a strict per-document JSON schema, and **again only on disagreement**.
- **Accuracy:** highest of the three for exact characters and numbers, because a checksummed number read by OCR+Verhoeff beats a VLM's guess, and the QR gives verified fields on Aadhaar.
- **Hallucination risk:** **lowest** — the VLM maps evidence it is *shown*; numbers/dates are cross-checked against OCR/QR/MRZ; boxes let you require evidence.
- **Latency:** +0.5–2 s/page for local OCR (CPU), parallelisable.
- **Privacy:** OCR/QR/preprocess run **locally**; only the (optionally redacted) token list + image go to Cloudflare for mapping. You can even map from **text alone** for low-sensitivity fields, keeping the image on-box.
- **Complexity:** medium-high (ONNX runtime, WASM, a Python sidecar if you later want Surya/Malayalam).
- **Cost / 1,000 apps:** similar Cloudflare spend to A (fewer, cheaper calls) + **$0 marginal** for local OCR (CPU/time only).
- **Model calls:** ~4 VLM calls/app + local OCR (free).
- **Pros:** best accuracy + lowest hallucination + best privacy + positional evidence. **Cons:** most moving parts; Malayalam needs Tesseract/Surya (PP-OCRv5 lists Devanagari/Tamil/Telugu but **not Malayalam** **[VERIFIED]**).

### Architecture C — Cloudflare + one specialised paid ID-OCR API

Only if A/B prove unreliable on your real document mix. Use a specialised API for the hard/lucrative documents (passports, global IDs) and Cloudflare for the rest.

- Options **[VERIFIED 2026-07-29]**: **Azure AI Document Intelligence prebuilt `idDocument`** (global passports/IDs; **F0 free 500 pages/mo**, S0 **~$10/1,000 pages**); **AWS Textract AnalyzeID** (**$0.025/page**, US-doc-focused); **Google Document AI** identity processors (**$0.10/doc**, **no Aadhaar/PAN**); **Mindee** (~**$0.044/page**); India-specific KYC (Surepass/IDfy — **pricing not public**).
- **Accuracy:** highest on **passports/MRZ and Western IDs**; **none of the majors has an Aadhaar/PAN parser** **[VERIFIED]**, so for Indian cards you still fall back to A/B.
- **Hallucination risk:** low on supported doc types (these return structured, positioned fields).
- **Latency:** ~1–3 s/doc.
- **Privacy:** **documents leave to a third KYC vendor**; region-pinned processing; retention varies and is partly **[UNVERIFIED]**. Heaviest compliance burden.
- **Complexity:** medium; **cost scales linearly** (~$10/1,000 pages Azure) unlike A/B.
- **Cost / 1,000 apps:** ~**$10** (Azure, 1 page each) up to ~$40 for 4 pages each — 100×+ the marginal cost of A/B.
- **Pros:** best on passports out of the box, positional fields, vendor SLA. **Cons:** cost, privacy, and it still doesn't solve Indian cards — so it's an **add-on to B**, not a replacement.

---

## 4. Recommended architecture

**Prototype now: Architecture B**, but staged. Ship **B-minimal** first: `sharp` preprocessing + deterministic validators + **one** Cloudflare VLM per page under a strict per-document JSON schema, with **tesseract.js already wired as the number/MRZ cross-reader**. Add PP-OCRv5-ONNX and Aadhaar-QR decoding as Stage-2 accuracy upgrades once the isolation and hallucination fixes are in and proven.

**Production later: Architecture B + selective C.** Keep B for Indian cards; add **Azure `idDocument`** for passports and non-Indian IDs where its MRZ/positional output and SLA justify the per-page cost and the extra DPA. Move face matching to a calibrated local ArcFace (ONNX) or a hosted compare API with a benchmarked threshold.

Rationale, tied to your decision rules: the dangerous defects are deterministic (isolation, capability rows, cache provenance). B minimises hallucination and maximises evidence-grounding *and* privacy, and it degrades gracefully to A if a model is retired. **No architecture is allowed to re-enable issuance until §14's gates pass** — the model choice is orthogonal to that.

---

## 5. Cloudflare models selected, and why — **[VERIFIED 2026-07-29, developers.cloudflare.com]**

The current config (`lib/config.js:64-67`) uses `@cf/moondream/moondream3.1-9B-A2B` (primary) and `@cf/meta/llama-3.2-11b-vision-instruct` (cross-check). Verified findings that change the recommendation:

- **`@cf/moondream/moondream3.1-9B-A2B`** — live; Image-to-Text; base64/URL image input; **$0.30/M in, $1.00/M out**. **No `response_format` / JSON-schema support documented.** Good cheap reader, but you cannot force schema-valid JSON — you rely on prompt discipline + your `stripFences` parser, which is fragile.
- **`@cf/meta/llama-3.2-11b-vision-instruct`** — **still live, NOT deprecated** (checked the 2026-05-08 deprecation changelog; it is not on the list). Vision + **the only vision model on the official JSON-Mode supported list**. **$0.049/M in, $0.676/M out.** Requires one-time Meta licence acceptance (your `vision.js:40-43` already handles the 403).
- **`@cf/google/gemma-3-12b-it`** — **DEPRECATED 2026-05-30.** If anything in your notes points here, it must move.
- **`@cf/google/gemma-4-26b-a4b-it`** — its replacement; **vision + `response_format`, 256K context, $0.100/M in, $0.300/M out** — the **cheapest schema-capable vision model** in the catalog.
- **`@cf/meta/llama-4-scout-17b-16e-instruct`** — vision + `guided_json`/`response_format`; **$0.27/M in, $0.85/M out**. (Image-passing shape on Workers AI is **[UNVERIFIED]** from the page — validate before committing.)
- **`@cf/moonshotai/kimi-k2.6`** — vision + `response_format`, huge context, **$0.95/M in, $4.00/M out** — capable but the most expensive; reserve for hard disagreements only.
- **No dedicated OCR model** and **no face model** exist in Workers AI **[VERIFIED]**. `toMarkdown()` is a converter, not true OCR.

**Selected mapping for the rebuild:**

| Stage | Model | Why |
|---|---|---|
| **Primary field mapping** | `@cf/google/gemma-4-26b-a4b-it` | cheapest **schema-enforced** vision output; kills the fenced-JSON fragility; multilingual heritage from gemma-3 |
| **Cross-check / disagreement** | `@cf/meta/llama-3.2-11b-vision-instruct` (JSON-mode) **or** `@cf/meta/llama-4-scout-17b-16e-instruct` | independent second read only when primary is low-confidence/null on a required field or classifier is borderline |
| **Hard-case tie-break (optional)** | `@cf/moonshotai/kimi-k2.6` | rare, expensive; only when two readers disagree on an identity-critical field |
| **Exact number/MRZ/QR** | **not a model** — Tesseract/PP-OCRv5 + `mrz` + Verhoeff + `zxing-wasm` | a checksummed read beats any VLM guess |
| **Face** | **local** ArcFace-ONNX or `@vladmandic/human` | no Workers AI face model exists |

**Do not** hard-code these. Keep `CF_MODEL_*` env-driven (you already do), keep `scripts/check-models.js`, and add a **startup liveness gate** that refuses to issue if the configured primary is absent — the catalog churned 18 models on 2026-05-30.

---

## 6. Is local / specialised OCR required?

**Yes for numbers and MRZ; strongly recommended for exact text; optional (paid) for passports/global IDs in production.**

- **Deterministic first, always.** PAN/EPIC/passport regex, **Aadhaar Verhoeff**, and **MRZ 7-3-1 check digits** are already implemented well (`lib/validate/*`) and are more reliable than any VLM for numbers. Keep them as final authority.
- **Aadhaar Secure QR** (`zxing-wasm` + a ~50-line port of the pyaadhaar payload parser) gives **UIDAI-signed** name/DOB/gender/address/photo when the QR is legible — the single best ground truth you can get without a government API. **Add this.** **[VERIFIED]**
- **Exact character reading:** Workers AI has no OCR model and does not document Indic fidelity. **PP-OCRv5-ONNX (Node) + tesseract.js** give you characters, boxes and confidence locally and privately. Recommended, Stage 2. Note **Malayalam** needs Tesseract `mal` or Surya (PP-OCRv5 lacks it) **[VERIFIED]**.
- **Specialised paid API:** only in production, only for passports/non-Indian IDs, as an **add-on** — the majors have no Aadhaar/PAN parser **[VERIFIED]**, so it never replaces the local/Cloudflare path for your core documents.

---

## 7. Model-call flow

Per **logical document** (one page, or a grouped front+back), never across documents or applicants:

```
1. Preprocess (local, no model): MIME sniff → EXIF orient → rotate/deskew →
   crop → quality gate. If quality < threshold → status=retake_required, STOP.
2. Deterministic reads (local, no model): MRZ parse (passport), Aadhaar QR
   decode, regex+checksum number candidates, Tesseract/PP-OCR token+box list.
3. Classify (local, no model): evidence-based type from number/checksum/QR/MRZ/
   field-presence + (later) the model's vote. Borderline margin → needs_confirmation.
4. Primary VLM map (1 call): image + OCR tokens → per-DOCUMENT-TYPE strict JSON
   schema (only the fields that type/page can carry). response_format enforced.
5. Reconcile (local): fill/allow-override number & MRZ & QR fields from
   deterministic sources; reject any field the schema forbids for this type/page.
6. Cross-check VLM (0–1 call): ONLY if a REQUIRED field is null/low-confidence
   or classification was borderline. Merge per field with evidence.
7. Tie-break VLM (0–1 call, rare): only identity-critical disagreement survives.
Cache the result keyed by (bytes + extractor + prompt_ver + schema_ver + model_ids).
```

Barrier: **comparison does not start until every selected logical document is in a final state** (`ready | unreadable | rejected_file | retake_required | removed_by_user`). Typical spend: **1 VLM call/page**, occasionally 2, almost never 3.

---

## 8. Data-flow diagram

```
┌────────── Browser ──────────┐        ┌──────────────── Node server ────────────────┐
│ pick files / folder / ZIP   │        │  AUTH (OTP+session)                          │
│ per-file progress rows      │        │     │ session.user_id  (server-trusted)       │
│ NO cross-applicant state ───┼──POST──▶│  APPLICATION  (one per "new application")    │
│ (reset on new application)  │  files  │     ├─ upload_batch (ownership root)          │
└─────────────────────────────┘        │     └─ discovery: unzip/traverse/PDF-split    │
                                        │            │  (ZIP-slip/bomb/type guards)      │
                                        │            ▼                                   │
                                        │  JOB QUEUE (per document_id, idempotent)      │
                                        │   preprocess→deterministic→classify→map→      │
                                        │   validate→group(front/back)                  │
                                        │            │                                   │
   Cloudflare Workers AI ◀─image+tokens─┤   VLM mapping (scoped to ONE doc, per-type    │
   (gemma-4 / llama / kimi)            └─┤   schema).  No cross-file context.            │
                                          │            ▼                                 │
   local: sharp/opencv/pdfium/tesseract/  │   EXTRACTION (owned: user+app+batch+doc)    │
   pp-ocr/mrz/zxing/face-onnx  ◀──────────┤   cache keyed by bytes+versions             │
                                          │            ▼                                 │
                                          │   BARRIER: all selected docs final?          │
                                          │            ▼                                 │
                                          │   COMPARE (ownership-scoped hashes only)     │
                                          │   → verdict → DECISION POLICY                │
                                          │            ▼                                 │
                                          │   CONSENSUS (provenance) → ISSUE (Ed25519)   │
                                          │   only if decision == verified & no integrity│
                                          │   failure. Share tokens. Audit every step.   │
                                          └──────────────────────────────────────────────┘
        SQLite (encrypted at rest): users, applications, upload_batches, documents,
        extractions, logical_documents, comparisons, records, document_numbers,
        share_tokens, audit, corrections
```

---

## 9. Database schema changes

Add the **ownership chain** the brief specifies (`session → user_id → application_id → upload_batch_id → document_id → extraction_id → logical_document_id → comparison_id → gid`). Key changes:

**New / changed tables**

- `users (id PK, identifier UNIQUE, created_at)` — a stable server-side identity for a signed-in person (today only a `sessions` Map exists).
- `applications (id PK, user_id FK→users NOT NULL, status, created_at, …)` — add `user_id`, enforce it everywhere.
- `upload_batches (id PK, application_id FK NOT NULL, created_at)` — one discovery run.
- `documents (id PK, application_id FK NOT NULL, upload_batch_id FK NOT NULL, content_hash, relative_path, detected_mime, byte_size, status, created_at)` — **the ownership-scoped reference to a file.** A cache hit reuses immutable extraction rows but **always creates a new `documents` row owned by this application** (per the brief's rule).
- `extractions (content_hash, extractor, prompt_version, schema_version, model_ids, raw_fields, confidence, candidates, validation, classification, source, created_at, PRIMARY KEY(content_hash, extractor, prompt_version, schema_version, model_ids))` — **immutable, deduplicated, no user data ownership** (it's byte-scoped compute). **Remove `overrides` and `face` from here.**
- `logical_documents (id PK, application_id FK NOT NULL, type, page_role, member_document_ids JSON, created_at)` — front/back/page grouping, scoped to one application.
- `face_embeddings (document_id FK PK, application_id FK NOT NULL, embedding BLOB, box, quality, created_at)` — **owned**, not stored on the byte-keyed extraction.
- `corrections (id PK, application_id FK NOT NULL, document_id FK NOT NULL, field, value, actor, created_at)` — holder overrides, **separate from raw extraction**, attributed and owned.
- `comparisons (id PK, application_id FK NOT NULL, verdict JSON, decision, created_at)` — replaces the loose `applications.verdict`.
- `records`, `document_numbers`, `share_tokens`, `audit` — keep, but `records` gains `application_id`, and `document_numbers` uniqueness stays global (a number backs one GID).

**Constraints & indexes**

- `PRAGMA foreign_keys = ON` (already set, `db/index.js:38`) with real FKs and `ON DELETE` behaviour.
- Every sensitive query takes `(user_id/application_id)` and filters on it server-side. **No query accepts a client hash without joining through `documents` to the owning application.**
- Unique: `records.dedup_hash`, `document_numbers(number, doc_type)`, `share_tokens.token`.
- Index: `documents(application_id)`, `documents(content_hash)`, `logical_documents(application_id)`, `extractions(content_hash)`, `corrections(document_id)`.

**No current-user/current-application state in process globals.** The `workflow` singleton is acceptable only because it holds no per-request identity; the leak came from the *data model*, not the singleton — but audit `app.js`/server for any place that assumes "the current documents."

---

## 10. Upload / folder / ZIP design

Support: single, multi-select, folder (`webkitdirectory`), drag-and-drop folders, ZIP, recursive traversal, multi-page PDF, front/back grouping, per-file progress, cancel/retry.

Each discovered file gets: `document_id`, `application_id`, `upload_batch_id`, `relative_path`, `content_hash`, server-sniffed `mime` (from bytes, **not** the client header), `byte_size`, `status`.

**Safety limits (recommended):** max **50** files/application; max **200 MB** total expanded; max ZIP **compression ratio 100:1** (bomb guard) and max **1** level of archive nesting (reject nested ZIPs); reject symlinks, executables and misleading extensions (sniff bytes); normalise and confine paths to prevent **ZIP-slip** (reject any entry resolving outside the extract root); dedupe by content hash; per-file timeout.

Process **each file independently with controlled concurrency** (queue, cap ~5) — **never** send a whole folder into one prompt. **Front/back grouping** is scoped to one application and joined by heuristics that cannot mix people: same `document_number` (or masked suffix), matching `type`, adjacency in the batch, and — where present — the same face embedding. When grouping is uncertain, keep pages **separate** and ask, rather than merging.

---

## 11. Extraction schema (evidence-constrained)

Adopt the per-field envelope from the brief, stored as **raw** (immutable) separately from **normalized** and from **corrections**:

```json
{
  "raw_value": "… | null",
  "normalized_value": "… | null",
  "confidence": 0.0,
  "status": "extracted | not_present | unreadable | invalid | conflicting",
  "source": "ocr | vision | mrz | barcode | user | deterministic",
  "evidence_text": "… | null",
  "page": 1,
  "bounding_box": null,
  "validator_results": [],
  "model_version": "…",
  "prompt_version": "…"
}
```

Rules enforced in the backend (not just prompted): a value must be backed by evidence; missing stays `null` (never `"N/A"` — your `NULLISH` set in `schema.js:25-28` already does this, keep it); no inferring a family member's name; no consensus values during individual extraction; no copying across documents; **the backend rejects any field the document/page schema forbids** (see §12), setting it to `status:"invalid"` instead of storing it.

**On bounding boxes:** the current Workers AI vision path **cannot** return coordinates, so `bounding_box`/`evidence_text` can only be populated when you add **local OCR (PP-OCRv5/Tesseract TSV/hOCR)** or MRZ/QR positions. Recommendation: make boxes **optional but preferred** — required for a field to count as "strong" evidence, absent for VLM-only reads (which are then "soft"). This is a concrete reason to prefer **Architecture B**.

---

## 12. Document capability matrix (page-aware, global-ready)

Replace the single per-type matrix with a **schema registry**: `country → document_type → layout/version → page_role → { allowed, required, optional, impossible, validators, evidence }`. Generic categories first (passport, national_id, tax_id, driving_licence, voter_id, birth_certificate), then country/layout specialisations. Illustrative rows (fixes §1.4/§1.5):

| Doc / page | Allowed | Required | **Impossible (reject if emitted)** |
|---|---|---|---|
| **Passport bio page** | surname, given_names, holder_name, passport_no, nationality, dob, sex, place_of_birth, issue/expiry, issuing_authority, MRZ | holder_name, passport_no, dob | **father_name, mother_name, spouse_name, residential_address** |
| **Passport back page** | father_name, mother_name, spouse_name, address | — | passport_no (usually) |
| **PAN** | holder_name, father_name, dob, pan_no | holder_name, pan_no | **gender, address** |
| **Aadhaar (front)** | holder_name, dob/yob, gender, aadhaar_no, address | holder_name, aadhaar_no | **father_name** (unless S/O·D/O·W/O line visible) |
| **Voter ID (front)** | holder_name, father_or_husband_name, dob/age, epic_no, sex | holder_name, epic_no | fields not on that side |

"Impossible" is enforced twice: the **prompt** only asks for allowed fields, and the **validator** drops/flags anything outside the set even if the model hallucinates it. A missing/unsupported field **abstains** (neither agreement nor disagreement) — the matrix already has the `participates/expects/ignoresBlank` machinery (`matrix.js:81-89`); extend it with `impossible` and `page_role`.

---

## 13. Comparison algorithm

Run **only after the barrier** (§7). Each field comparison knows: which doc types/pages may supply it, which abstain, raw + normalized value, source, confidence, validation status, and whether the user corrected it. Keep the current strong parts (matrix filtering, clustering, glued-name handling, char-level diff) and harden:

**A. Person names — multi-signal, explainable (not one score).** Combine, and *show*, several signals rather than a single threshold: token-set alignment (order-insensitive — already in `normalize/name.js`), per-token weighted edit distance, glued-form comparison (already in `levenshtein.js:76-121`), initial/surname-initial handling, abbreviation-as-alternate (already in `name.js:16-25`), plus **add** Jaro-Winkler and Double-Metaphone/phonetic and transliteration-aware matching for Indic romanisation. Classify each difference as **safe-normalise** (case/space/order/honorific/expansion) vs **needs-confirmation** (1–2 char, initial vs full, surname-initial relationship like `PARATHODI` + given `MUHAMMED MISHAB SALEEM`) vs **hard-different** (multiple tokens differ, high distance on glued form). **Never hard-reject on a single low-confidence OCR name** — that path becomes `needs_confirmation` (already the intent, `compare/index.js:66-69`; keep and calibrate the distance-2 rule).

**B. Dates** — normalize all formats to ISO (already good, `normalize/date.js`), keep 2-digit-year pivot, flag DD/MM vs MM/DD ambiguity rather than guessing, treat year-only as partial (not mismatch), and treat an unparseable date as `unreadable`, not a contradiction. Add an **age/DOB sanity** cross-check (e.g., DOB implying age <0 or >120 → `invalid`).

**C. Gender/sex** — fold multilingual/abbreviated to M/F/O (already `normalize/gender.js`), keep absent distinguishable from "other," never treat absent as mismatch.

**D. Addresses** — parse into house/street/locality/district/state/postal/country; compare **structurally** and **advisory only** (never blocks — already `info`); **never** compare place-of-birth against address (fixed by §12 forbidding passport address). Allow address change without concluding false identity.

**E. Document numbers** — exact per-type pattern + checksum, validated individually, **never fuzzy-matched across documents** (already correct, `matrix.js:57`, `NEVER_COMPARED`). Never treat two different valid numbers as a mismatch.

**F. Family names** — compare father/mother/spouse **only when the same relationship is explicitly present on both** and the page is allowed to carry it. Keep the father/husband pooling (`COMPARISON_GROUPS.guardian_name`) but **remove passport from the parent-name voters** (§12).

**G. Face** — kept entirely separate from text (§15); advisory; contributes to the decision as corroboration, never as proof.

---

## 14. Decision policy

Replace binary match/reject with explicit states:

`verified_match` · `likely_match_needs_confirmation` · `insufficient_evidence` · `extraction_failed` · `document_conflict` · `suspected_cross_identity` · `rejected_invalid_document` · `blocked_security_integrity` · `retake_required`.

Rules:

- **Hard contradiction** (≥1 identity field genuinely different beyond OCR distance, on evidence-strong reads) → `document_conflict`, block.
- **Soft difference** (distance 1–2, initial/surname relationship, single low-confidence read) → `likely_match_needs_confirmation`; user confirmation can clear it.
- **Abstention / unreadable** → never a contradiction; if a required identity field is unreadable on all carriers → `insufficient_evidence` (ask for a retake / manual entry).
- **Minimum independent evidence to issue:** at least **two independent documents** agree on `name` **and** `dob`, each from an **evidence-strong** source (validated number/QR/MRZ or two-model agreement), with **no hard contradiction** and **no integrity failure**.
- **User confirmation is sufficient** for soft differences and unreadable-but-typed fields; **manual review is required** for `document_conflict` or `suspected_cross_identity`.
- **A single OCR disagreement never auto-rejects.**
- **Any cross-user / cross-application integrity signal → `blocked_security_integrity`, always, and issuance is impossible** regardless of field agreement. Integrity signals include: a comparison containing a document whose `application_id` ≠ the current application; a cache hit reused without a fresh owned `documents` row; or a face/number belonging to another application.

**Issuance re-enable point:** Golden ID minting stays **disabled** until (a) the ownership chain (§9) is enforced and a **cross-application isolation test suite passes with zero leakage**, (b) the passport/parent/address capability fix (§12) is in and tested, and (c) the decision policy above is implemented. Until then the system may **extract, compare and show a verdict**, but the "issue" path is a no-op that returns `blocked_security_integrity: issuance disabled pending isolation sign-off`.

---

## 15. Face strategy

Local pipeline, benchmarked before any weight is put on it:

`EXIF-orient (sharp, server-side) → optional rotation search (0/90/180/270) → face detect → landmark align → quality gate (blur via variance-of-Laplacian, min face px, pose, occlusion) → embedding → cosine similarity → calibrated threshold`.

- **Fix the orientation bug first** (§1.8): server-side `sharp().autoOrient()` before decode, and enable rotation in detection.
- **Reject low-quality crops** (too small / blurred / off-pose) as `insufficient_quality` rather than emitting a misleading 0.19.
- **Runtime:** `@vladmandic/human` works but is low-activity (last release Feb 2024) **[VERIFIED]**; for production evaluate **ArcFace/buffalo_l via onnxruntime-node** (note InsightFace model licence is research-only **[VERIFIED]**) or a hosted compare (AWS Rekognition CompareFaces **$0.001/image [VERIFIED]**).
- **Calibrate, don't guess.** ArcFace-style cosine thresholds published for selfie datasets (~0.68 cosine-distance) **[VERIFIED]** do not transfer to printed ID photos — recalibrate on your own doc-vs-doc pairs.
- **Never use synthetic-face similarity as proof** (your current tests do — §1.13). **Require a real benchmark** (§18) before face contributes anything beyond an advisory note. It stays a `warn`, never a block, and **never** includes another application's document.

---

## 16. Cache design

- **Key = `SHA-256(bytes) + extractor + prompt_version + schema_version + model_ids`.** A prompt/model change invalidates cleanly (fixes §1.7).
- **Cache holds ONLY the immutable extraction** (raw fields, confidence, candidates, validation, classification, source). **No** overrides, **no** face, **no** consensus, **no** comparison, **no** Golden ID state, **no** selected-document set.
- **A cache hit reuses the extraction but creates a new, ownership-scoped `documents` row** for the current application (brief's explicit rule).
- **Face embeddings move to `face_embeddings` keyed by owned `document_id`** (§9), not the byte-keyed extraction.
- **Corrections move to `corrections`** (owned, attributed), never mutating raw extraction.

---

## 17. Security controls

- **Encryption in transit** (TLS termination in front; never expose the raw Node port over a tunnel without it) and **at rest** (encrypt the SQLite file / use SQLCipher, and encrypt `.uploads/` or hold images in memory only).
- **Delete source scans** as soon as extraction + embedding are cached (already done, `application.js:120-125`); keep the TTL sweep (`uploads.js:71-88`); shorten TTL for real docs.
- **Redacted logs** — never log raw numbers, names, faces, tokens, or full images or model bodies. Scrub `vision.js` error `body` slices.
- **Ownership on every sensitive route** (§9); no client-supplied ID is trusted without a server-side ownership join.
- **Rate limiting** on OTP, extract, compare; **lockout** on OTP brute force (partial today, `server.js:97`).
- **Real OTP delivery** — stop returning `demoOtp` (`server.js:89`) once reachable off-localhost.
- **Retention policy + deletion requests** — a documented TTL for extractions and a "delete my data" path that also revokes derived Golden IDs.
- **Audit** every step (issue/share/retrieve/deny already audited, `record/issue.js`; extend to extraction, comparison, correction, and **integrity blocks**).
- **Invalidate contaminated Golden IDs** — `GID-F5B95AA5B893` and any record issued from a multi-applicant or 2-document comparison should be reviewed and revoked as part of migration (§19).
- **Signed share tokens** are already short-lived/scoped/audited (`record/issue.js:153-223`) — keep.

---

## 18. Testing & benchmark plan

The failure was a **test-design** failure, so the plan leads with the tests that were missing.

**Must-have new suites (block issuance until green):**

- **Database ownership / isolation** — two applications, two users; assert application B's comparison can **never** include application A's documents, faces, corrections, cache rows or consensus. **Acceptance: zero leakage.** Include the exact reproduction: issue app A, then app B without logout, assert B's verdict contains only B's hashes.
- **Concurrency** — two simultaneous users interleaved; assert no shared documents/extractions/faces/comparisons/progress.
- **Capability enforcement** — a passport extraction that emits father/mother/address is **rejected/flagged** and **cannot** reach consensus.
- **Cache provenance** — same bytes + changed prompt/model = new extraction; cache hit yields a **new owned `documents` row**.
- **Adversarial** — ZIP-slip, ZIP-bomb, nested archive, misleading extension, symlink, 12-digit-Aadhaar-labelled-PAN, tampered checksum, two different people with near-identical names, same filename/different bytes, different filename/same bytes.
- **Live-model tests** (separate, opt-in, not in CI default) — real Cloudflare calls on a small labelled set; assert schema-valid JSON and type accuracy.
- **Real-face benchmark** — labelled genuine/impostor document-photo pairs; report FAR/FRR and a calibrated threshold. **No synthetic vectors as proof.**
- **End-to-end browser** — upload→compare→(blocked)issue with the isolation reset between applicants.

**Benchmark corpus** — multiple countries; passports, national IDs, tax IDs, driving licences, voter IDs; front/back; rotated/blurred/glare; varied layouts/issue-years; multilingual; missing fields; tampered numbers; same-person spelling variants; look-alike different people; concurrent users; repeated cache uploads; filename/bytes permutations; ZIP/folder batches.

**Metrics** — document-type accuracy; exact-character accuracy; field exact-match; **unsupported-field hallucination rate**; missing-field false-fill rate; false-match rate; false-rejection rate; manual-confirmation rate; face FAR/FRR; **cross-user leakage count (target 0)**; **cross-application leakage count (target 0)**; **cache-contamination count (target 0)**; latency; model/API cost.

---

## 19. Migration steps

1. **Freeze issuance** — make the issue path a no-op returning `blocked_security_integrity` (feature flag). Ship this first; it is safe to deploy immediately.
2. **Quarantine existing data** — export and review the current `golden-id.sqlite`. Treat every extraction as unowned; **revoke `GID-F5B95AA5B893`** and any record from a <3-document or multi-applicant comparison pending re-verification.
3. **Introduce the ownership schema** (§9) alongside the old tables; write a migration that creates `users`/`applications.user_id`/`upload_batches`/`documents`/`logical_documents`/`corrections` and **does not** backfill unowned extractions into any application.
4. **Split the extraction row** — move `overrides`→`corrections`, `face`→`face_embeddings`; re-key `extractions` by bytes+versions.
5. **Enforce ownership** in every query; delete any code path that accepts a client hash without an ownership join.
6. **Frontend reset** — clear `selectedFiles`/`extracted` on every new application, not only logout; add an explicit "new application" action; fix the false "never leaves your browser" copy.
7. **Capability fix** — page-aware schema registry; forbid passport parent/address.
8. **Cache provenance**, then **preprocessing**, then **face orientation** fixes.
9. **Re-enable issuance** only after §14's gates and §18's isolation/capability suites pass.

Each step is independently deployable behind flags; issuance stays off until the end.

---

## 20. Cost & latency estimate

Assumptions: ~4 pages/app; **[VERIFIED]** Cloudflare pricing (neurons $0.011/1k, free 10k/day; gemma-4 $0.10/$0.30 per-M; llama-3.2-11b-vision $0.049/$0.676 per-M).

- **Architecture A/B, 1,000 apps:** ~4,000–5,600 VLM calls. Even at a few hundred–low-thousand tokens/call, spend is **~$5–25 total**, dominated by per-call overhead; local OCR/QR/preprocess/face add **$0 marginal** (CPU/time). Latency **~2–6 s/app** wall-clock with concurrency 5, more if a cross-check or reclassify fires.
- **PDFs / front-back / retries:** a 2-page PDF = 2 logical reads; front+back grouped = 2 reads then 1 comparison; each retry is +1 call. Budget **+25%** for retries/cross-checks and **×pages** for multi-page PDFs.
- **Architecture C add-on (production passports):** Azure `idDocument` **~$10/1,000 pages** after the 500/mo free tier — i.e., passports alone at 1 page each ≈ **$10/1,000 apps**, 100×+ the marginal Cloudflare cost. Use selectively.
- **Face (hosted option):** Rekognition CompareFaces **$0.001/image** — negligible; local ONNX is free.

Cost is **not** the binding constraint at prototype scale; **accuracy, hallucination and isolation** are.

---

## 21. Risks & remaining limitations

- **Indic OCR fidelity is unproven** on Workers AI and only partly covered locally (**Malayalam** absent from PP-OCRv5 — needs Tesseract/Surya) **[VERIFIED]**. Character accuracy on regional cards is the top accuracy risk.
- **VLM-only reads have no positional evidence** — the `evidence_text/bounding_box` guarantee is only real once local OCR is added (Stage 2).
- **Glued-name tolerance can over-merge** two genuinely different short names; keep it as `needs_confirmation`, not silent-merge, on identity fields.
- **Face matching on printed photos stays weak** even after fixes; treat as advisory indefinitely until a real benchmark says otherwise.
- **Model-catalog churn** (18 models retired 2026-05-30) means a hard runtime dependency on IDs that can vanish; the liveness gate mitigates but does not eliminate.
- **This is not a government credential** and cannot verify against UIDAI/Protean/ECI/DigiLocker; the disclaimers must stay.
- **Aadhaar handling is legally sensitive** — storing/masking Aadhaar numbers and photos has regulatory implications in India; get that reviewed before any non-prototype use.

---

## 22. Phased implementation plan (independently testable)

- **Phase 0 — Freeze & prove the bug (0.5 day).** Feature-flag issuance off. Write the failing **isolation test** (two applicants, one session) and the failing **passport-hallucination test**. Land them red. *Nothing else proceeds until these exist.*
- **Phase 1 — Ownership data model (2–3 days).** Schema §9; enforce ownership in every query; frontend per-application reset; fix false privacy copy. **Turns the isolation tests green.**
- **Phase 2 — Capability registry & extraction schema (2 days).** Page-aware allowed/required/impossible; backend rejects forbidden fields; remove passport from parent voters. **Turns the hallucination tests green.**
- **Phase 3 — Cache provenance & corrections split (1 day).** Re-key extractions; move overrides/face out; cache-hit → new owned document row.
- **Phase 4 — Preprocessing & quality gate (2–3 days).** `sharp` EXIF/resize, MIME sniff, blur/glare/resolution gate, `retake_required`; PDF raster via pdfium.
- **Phase 5 — Deterministic reading upgrades (2–3 days).** Aadhaar Secure-QR decode; wire MRZ/number cross-read into classification; add `needs_confirmation` to the classifier.
- **Phase 6 — Comparison & decision policy (2–3 days).** Multi-signal names (add Jaro-Winkler/phonetic/transliteration), structured address, explicit decision states, minimum-evidence rule.
- **Phase 7 — Face fixes (2 days).** Server EXIF orient, rotation search, quality gate; keep advisory.
- **Phase 8 — Upload/folder/ZIP + job queue (3–4 days).** Discovery with all safety limits; per-file progress; idempotent retries; comparison barrier; progress survives refresh.
- **Phase 9 — Local OCR (PP-OCRv5-ONNX) + boxes (3–4 days, optional accuracy upgrade).** Populate `evidence_text/bounding_box`; make VLM a mapper.
- **Phase 10 — Benchmark harness & real-face benchmark (2–3 days).** §18 corpus + metrics.
- **Phase 11 — Security hardening (2 days).** Encryption at rest, rate limits, real OTP path, retention/deletion, redaction.
- **Phase 12 — Re-enable issuance (0.5 day).** Only after §14 gates + §18 isolation/capability suites pass.

---

## 23. Acceptance criteria per stage

- **P0:** issuance disabled; two red tests exist (isolation, passport-hallucination).
- **P1:** every sensitive query filters by owner; isolation + concurrency suites **zero leakage**; frontend cannot carry a file across applications; privacy copy accurate.
- **P2:** a passport emitting father/mother/address is flagged `invalid` and cannot reach consensus; capability tests green for all types/pages.
- **P3:** prompt/model change forces re-extraction; cache hit yields a new owned document row; no override/face on the byte-keyed row.
- **P4:** rotated/blurred/glare fixtures produce `retake_required`, not hallucinated fields; multi-page PDF splits into N logical documents.
- **P5:** Aadhaar QR fields verified against visual read; classifier returns `needs_confirmation` on borderline margin; misread-number does not silently misclassify.
- **P6:** the `MUHAMMEDSAKIR K` / surname-initial cases resolve to `needs_confirmation`, not reject; a genuinely different person still rejects; single OCR disagreement never auto-rejects.
- **P7:** the known good pair no longer scores ~0.19 after orientation fix; low-quality crops report `insufficient_quality`.
- **P8:** ZIP-slip/bomb/nested/symlink/misleading-extension all rejected; comparison never starts before all selected docs are final; progress survives a refresh; no duplicate Golden IDs under duplicate requests.
- **P9:** every strong field carries `evidence_text/bounding_box`; character-accuracy metric improves on the benchmark.
- **P10:** benchmark produces every §18 metric; cross-user/app/cache leakage counts are **0**.
- **P11:** DB and uploads encrypted at rest; OTP not returned in responses; rate limits enforced; deletion request revokes derived GIDs.
- **P12:** all above green → issuance re-enabled behind the flag.

---

## 24. Rollback plan

- **Every phase ships behind a feature flag** and is independently revertible; the ownership schema is added **additively** (new tables/columns), so a rollback is a flag flip, not a destructive migration.
- **Issuance flag** is the master safety switch: if any regression touches isolation or capability enforcement, flip issuance **off** immediately (it is off by default until P12) — extraction/comparison keep working for diagnosis.
- **DB migrations** are forward-only but reversible in effect: keep the pre-migration `golden-id.sqlite` as a timestamped backup before each schema step; new tables can be dropped without touching legacy data.
- **Model rollback:** `CF_MODEL_*` env vars let you revert to a previous working model instantly; the liveness gate refuses to start on a bad ID rather than degrading silently.
- **Contaminated records:** revocation is already supported (`records.revoked`); a rollback of the capability fix must **re-freeze issuance**, not re-open it.

---

## 25. Questions that genuinely need your decision

1. **Scope of documents.** Is this Indian-only for the prototype, or global from the start? It changes the schema registry size and whether Architecture C (Azure passports) is in scope now.
2. **Aadhaar handling.** Are you willing to store/compare Aadhaar numbers and photos at all, given Indian legal sensitivity — or should Aadhaar be QR-verified-then-discarded (store only a masked reference)?
3. **Privacy posture vs accuracy.** Architecture B can keep images **on-box** for OCR and send only text to Cloudflare. Do you want maximum privacy (text-only to the cloud where possible) even at some accuracy cost, or best accuracy (send images)?
4. **Malayalam / regional scripts.** Do you need Malayalam now? If yes, we must add Tesseract `mal` or a Surya sidecar (PP-OCRv5 lacks it).
5. **Face matching's role.** Advisory-only forever, or eventually a gating signal once benchmarked? This sets how much to invest in the face pipeline and whether a hosted compare API is acceptable.
6. **Specialised paid OCR.** Are you open to a third KYC/OCR vendor (Azure/Mindee/Surepass) in production for passports, accepting the added DPA and per-page cost — or Cloudflare + local only?
7. **Deployment surface.** Will this ever be exposed beyond localhost (tunnel/hosted)? If yes, security hardening (P11) moves ahead of feature work.
8. **Existing data.** Confirm I may treat the current `golden-id.sqlite` as disposable test data and revoke `GID-F5B95AA5B893` during migration.
9. **Consensus weighting.** Majority vote, or **source-quality-weighted** (a Verhoeff-valid/QR/MRZ-backed field outranks a single VLM read)? I recommend source-quality weighting; confirm.
10. **Budget & timeline.** The phased plan is ~4–6 focused weeks for one engineer to P12. Is that the envelope, or do you want a thinner "minimum safe" cut first (below)?

---

## Minimum-safe prototype vs production-grade future

**Minimum safe prototype (issue can be re-enabled):** Phases 0–3 + 6 + the isolation/capability/cache tests. This gives you: per-application isolation, no hallucinated fields in consensus, honest cache provenance, an explicit decision policy, and issuance gated behind those. Extraction stays Cloudflare-VLM + deterministic validators (Architecture A/B-minimal). Face and folder/ZIP can wait.

**Production-grade future:** all phases, Architecture B (+ selective C for passports), local OCR with bounding-box evidence, calibrated benchmarked face matching, encryption at rest, rate limiting, real OTP, retention/deletion, and a labelled benchmark that reports zero leakage and measured accuracy before any real-world use.

**Disable until safe:** Golden ID **issuance**; the "Fetch from issuer" buttons (not connected); any claim of government verification; folder/ZIP bulk upload (until safety limits land); face as anything but an advisory note.

**Can remain on:** OTP + consent gates; per-document extraction and the field-by-field verdict view; the evidence-based classifier; deterministic validators; Ed25519 signing/share-token machinery; manual per-field correction.

**Exact point issuance may be re-enabled:** when (1) the ownership chain is enforced and the **cross-application isolation suite passes with zero leakage**, (2) the **passport/parent/address capability fix** is in and its tests pass, and (3) the **decision policy** with `blocked_security_integrity` is implemented and any integrity signal provably blocks issuance. Not before.

---

*End of review. No repository files were modified. Awaiting your decisions on §25 before any implementation begins.*
