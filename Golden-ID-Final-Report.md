# Golden ID — Final Report

**Branch:** `claude-refactor-fixes` (10 commits on top of `40e60d6`, each independently revertible)
**Verification:** 282/282 automated tests green · full live browser run against real Cloudflare Workers AI · dev database byte-untouched
**Date:** 30 July 2026

---

## 1. Current architecture

```
Browser (public/app.js — no framework)
  │  epoch-guarded state · sessionStorage application id · content-hash file linking
  ▼
HTTP layer (server.js — routing only)
  │  OTP auth → session · rate limits · every document resolved through the owning application
  ▼
Workflow (lib/application.js)
  │  ingest → dedup by content hash → discover (ZIP/PDF/MIME sniff) → register owned rows
  │  compare → explicit documentIds → integrity → grouping → verdict → audit
  │  confirmVariation → guarded soft-variant confirmation → re-compare
  ▼
Extraction (lib/extract/) — immutable, cached by bytes+versions
  │  quality tier (good/marginal/unusable) → enhancement variants (marginal)
  │  Aadhaar QR + MRZ (checksummed) → classify → focused vision read → cross-check
  │  OCR-consensus recovery → targeted field re-read → evidence assessment (5 field states)
  ▼
Comparison (lib/compare/) — capability matrix → presence gates → clustering
  │  corroboration = DISTINCT LOGICAL DOCUMENTS with document evidence
  │  name cascade (Damerau/Jaro-Winkler/phonetic/n-gram) → decision policy (11 states)
  ▼
Record (lib/record/) — consensus with provenance → Ed25519 signature → dedup → share tokens
  ▼
SQLite (lib/db/) — users → applications → batches → documents (+ confirmations, corrections,
                    comparisons, records, audit); extractions byte-scoped outside the chain
```

## 2. Root cause → fix, for every reported problem

### Problem 1 — Old/removed documents reappeared in the upload screen
**Root causes (all confirmed by failing tests before each fix):**
- `app.js` rebuilt its document map from server responses that **included removed rows**, then linked new uploads to staged files **by array position** — a removed row adopted a new file's identity and the new row rendered as a duplicate.
- The application id lived only in a JS variable: refresh orphaned it, back/forward-cache restored stale state, and an upload still in flight when you clicked "Start a new application" delivered the **old** application's documents into the new workspace.

**Fixes:** documents link to files by **SHA-256 content hash** (server echoes `contentHash`); rendering, counts and selection filter `removed_by_user`; the application id persists in `sessionStorage` and refresh/`pageshow` re-fetch truth via `GET /applications/:id`; an **epoch counter + AbortController** makes every stale async continuation discard itself.
**Proof:** live — removed Aadhaar never reappeared after a further upload; refresh and back-navigation resumed the exact application; a new application opened empty with a new UUID while the old one stayed resumable (even across a server restart).

### Problem 2 — Removed documents counted ("2 of 4 identified")
**Root cause:** counts used the raw server list (which contains removed rows) and were never recomputed after removal. Removed rows even consumed the 50-file upload budget.
**Fixes:** counts, rendering, selection, comparison, issuance and the upload budget all operate on active documents only; removal is stamped (`removed_at`), audited (`document_removed`), refuses a double-delete (409), and is **awaited** in the UI so a failed delete can no longer diverge client from server.
**Proof:** live — "1 of 1 document identified" immediately after removal; tests `removed documents stop consuming the upload budget`, `a removed document never reaches issuance`.

### Problem 3 — Duplicate file records
**Root cause:** ingest never checked `content_hash`; the same bytes always created a new row. (A test claiming to cover this uploaded a *different* file.)
**Fixes:** content-hash dedup inside the application — identical active bytes are **skipped with a reason** (`duplicate_of_active_document` / `duplicate_in_upload`); re-uploading a **removed** file **reactivates the original row** (audited, `removed_at` cleared); a row stuck mid-extraction >10 min is retried into the same row. Filenames are never used for dedup.
**Proof:** live — "1 file(s) had identical content to a document already here and were not added again", count unchanged.

### Problem 4 — Unclear comparison input
**Root cause:** `documentIds` was optional (absent/empty ⇒ "whatever is in the application"), duplicates were honoured, and — critically — **one card listed twice satisfied the two-document evidence minimum and could mint `verified_match` from a single photograph** (agreement was counted by document *type*; front+back of one card also counted as two sources).
**Fixes:** `documentIds` is **required, unique, active, owned** (400s: `document_ids_required`, `duplicate_document_ids`, `removed_document_selected`; foreign ids keep the audited 409 integrity block). Corroboration now counts **distinct logical documents** (front+back share a `logicalId`). Every request is audited (`comparison_requested` with the exact ids), the verdict displays "Compared exactly: …", the UI has per-document Compare checkboxes plus a filename manifest before the request, and issuance is scoped to the compared set.
**Proof:** tests `one card cannot become two sources…`, `two scans of one card are one source…`; live manifest + "Compared exactly: pan-asha.jpg, aadhaar-asha.jpg".

### Problem 5 — Small name differences needed safe confirmation
**Root cause:** `likely_match_needs_confirmation` existed but had **no endpoint, no table, no UI** — the only path was retyping the value as a "correction".
**Fixes:** `POST /applications/:id/confirmations` guarded so only a field the decision engine itself listed in `confirmable[]`, at `needs_confirmation` severity, on the **latest** comparison can be confirmed — hard conflicts are **structurally unconfirmable**. The INSERT-only `confirmations` table preserves both source values verbatim; the audit event `user_confirmed_soft_name_variation` records actor + timestamp; the same document selection re-compares; the verdict carries `holder_confirmed_variation`. The dialog shows both spellings with the character diff and the three required actions.
**Proof:** live — MUHAMMED/MUHAMMAD produced the dialog, confirmation issued the Golden ID, and the verdict reads "PAN reads 'MUHAMMED SAKIR K' — confirmed by you as the same person on 30/07/2026 04:13". A DOB conflict produced **no** dialog and `POST /confirmations` returns 400 `field_not_confirmable` (test-proven).

### Problem 6 — Manual corrections could fake evidence
**Root cause:** hydration re-injected every correction as `present_verified` with evidence weight **1.0** — a typed value counted as full-strength printed evidence and document agreement.
**Fixes (STRICT mode, per your choice):** corrections branch on what the document actually printed. A corrected **printed** value stays comparable (`user_correction`, weight 0.5, never evidence-strong) but **never counts toward the two-document minimum**. A value for a field the document never showed becomes **`holder_asserted`**: displayed, stored, abstaining from comparison entirely, labelled *"Applicant supplied; not verified from the uploaded document."* It unblocks a required field, downgrades the verdict from `verified_match`, enters the record as `verificationStatus: 'unverified'` / `provenance: 'applicant_supplied'`, and is **excluded from the identity-dedup fingerprint** so a typed DOB cannot steer which Golden ID an applicant collides with. The immutable extraction is never touched (pre-existing guarantee, now test-pinned end to end).
**Proof:** live — the typed DOB rendered with the exact required wording; tests `a typed value can never manufacture document agreement`, `a corrected printed value stays comparable but never corroborates`.

## 3. Additional defects found and fixed along the way

| Defect | Fix |
|---|---|
| Static-file path check accepted sibling dirs (`public.bak`) | separator-suffixed prefix check, unit-tested |
| Stale cached `app.js` could resurrect every fixed bug | static responses now `cache-control: no-cache` |
| Full document numbers leaked in `fields`/`rawFields`/evidence text | whole payload scrubbed of every spelling of the number |
| Two namesakes with unread DOBs collapsed onto one Golden ID | identity fingerprint requires name **and** DOB; document-number dedup still applies |
| Sessions/OTP challenges never expired from memory | swept every 5 min + deleted on read |
| `verify.html` read `fields.name` (always blank) | reads `holder_name` |
| A crash mid-ingest wedged the application behind 409 forever | stale `pending` rows self-heal to `unreadable` with a retry hint; re-upload retries in place |
| A cached quality-gate failure returned as generic "unreadable" | cache preserves the retake verdict and its reasons |
| Vision model near-JSON (prose, bare keys, trailing commas) discarded wholesale — **seen live from moondream** | syntax-only JSON repair before giving up; repair can never invent values |
| Holder-asserted value vanished when no document expected the field — **seen live** | the field stays visible with its unverified label |

## 4. The blur-recovery pipeline

**Tiers** (measured on a 512px grayscale downsample): `good` (read as-is) / `marginal` (recovery attempt) / `unusable` (honest refusal). Marginal floors: Laplacian sharpness 22–55, contrast 10–18, glare 10–22%, underexposure 55–70%. Resolution below 480×300 is always unusable — upscaling cannot invent pixels.

**Recovery for marginal images** (all in memory; the stored original is never modified):
1. Up to **3 enhancement variants** chosen by the failing metric: gray+normalise, CLAHE (64×64, slope 3), mild sharpen (σ1.2), conditional 2× upscale. Deliberately mild — an aggressive sharpen invents strokes.
2. Independent tesseract passes per variant (no extra vision-model cost); the richest text feeds the evidence layer, and a variant can reveal an MRZ the base pass missed.
3. **OCR-consensus:** a model value becomes `present_verified` only when ≥2 independent passes show it printed **under its label** (`verified_by_ocr_consensus`, variant provenance recorded). One sighting is not consensus (test-pinned).
4. **Targeted re-read:** ≤2 identity-critical fields still uncertain get a single-field vision re-read of the best enhanced view; agreement promotes (`verified_by_field_reread`), disagreement stays uncertain, and a visible-label-unreadable-value case is marked `field_area_found_but_unreadable` (the UI's "we found the date-of-birth area, but…" message).
5. Unusable images get the specific failing metric plus concrete camera guidance (flat dark surface, no flash, rear camera, all four corners, no WhatsApp re-compression) — never a generic "AI could not read it".

**Honest limits:** slight blur/compression is often recoverable (proven live: a genuinely blurred Aadhaar reached a fully verified read). Moderate blur may yield only uncertain evidence. Severe blur, glare, missing pixels or tiny text are **not recoverable** — enhancement sharpens what the sensor captured; it cannot recreate detail that was never captured, and nothing in this pipeline will pretend otherwise. Evidence-strength order is preserved throughout: checksummed QR/MRZ > OCR consensus > OCR+vision agreement > two models agreeing > one model with an evidence snippet > model-only (never verified).

## 5. API changes (before → after)

**`POST /api/v1/applications/:id/compare`**
- Before: `{ consent, documentIds? }` — absent/empty compared everything; duplicates honoured.
- After: `documentIds` required/unique/active/owned. New 400 codes `document_ids_required`, `duplicate_document_ids`, `removed_document_selected`. Response adds `selected`, per-field `corroboration` + `agreeingEntries`, and `verdict.confirmable`.

**`POST /api/v1/applications/:id/confirmations`** *(new)* — `{ consent, comparisonId, field, decision:'same_person' }` → fresh comparison + `confirmation`; 400 `field_not_confirmable`, 409 `comparison_superseded`.

**`POST /api/v1/applications/:id/documents`** — response adds `skipped[].reason` dedup codes, `reactivated[]`, `retried[]`; documents carry `uploadBatchId`, `contentHash`, `removedAt`.

**`DELETE …/documents/:id`** — stamps `removedAt`, audits, 409 `already_removed` on repeat.

**`GET /api/v1/applications/:id`** — unchanged; now the resume endpoint the frontend actually uses.

**Schema (idempotent migrations):** `documents.removed_at` via `ensureColumn`; new INSERT-only `confirmations` table. No existing data rewritten; first dev start after this branch migrates in place.

## 6. Test results

`NODE_ENV=test node --test` → **282 pass / 0 fail** (~5s, fully offline, in-memory SQLite; the dev `golden-id.sqlite` was byte-identical before and after the whole effort). Every bug fix landed **red-first**: the failing test was demonstrated against the pre-fix code (via stash) before the fix turned it green. All 25 requested regression scenarios are covered — 20 in the automated suite, and the 5 browser-lifecycle ones (refresh-resume, back-navigation, in-flight isolation, dialog, manifest) verified in the live run below.

## 7. Live run results (real Workers AI, scratch DB, synthetic cards)

| Scenario | Result |
|---|---|
| Sign in → new application → upload PAN+Aadhaar → compare | ✅ issued `GID-49D64E70CDE5`, "Name agreed by: Aadhaar, PAN", "Compared exactly: pan-asha.jpg, aadhaar-asha.jpg" |
| Refresh mid-flow | ✅ resumed the same application with both documents |
| Re-upload identical bytes | ✅ skipped with reason; count unchanged |
| Remove Aadhaar → upload Voter ID | ✅ removed doc never reappeared; "2 of 2" counts active only |
| Navigate away → Back | ✅ state re-synced from the server; nothing resurrected |
| Start a new application | ✅ new UUID, empty workspace; old application still resumable (even across a server restart) |
| MUHAMMED vs MUHAMMAD | ✅ three-button dialog → confirm → issued, both spellings kept with a timestamp |
| Hard DOB conflict | ✅ blocked for manual review; **no confirm dialog exists for it** |
| Marginal-blur Aadhaar | ✅ 3 enhancement variants ran; name+DOB verified; document `ready` |
| Heavy-blur Aadhaar | ✅ "Retake needed" with the specific reason + camera tips |
| Manual DOB (no document shows one) | ✅ unblocks, labelled "Applicant supplied; not verified from the uploaded document", record value `unverified` |

## 8. Remaining limitations (unchanged and stated plainly)

- ~~Llama cross-check licence~~ **Resolved (30 Jul 2026, user-authorized):** the one-time Meta licence was accepted on the account, and the adapter was corrected to the model's native run path (the OpenAI-compatible route rejects its image parts — probed against the live API). Both models now pass a real-inference smoke test; two-model cross-confirmation is active.
- Face matching is advisory only and its 0.5 threshold is an uncalibrated guess (`npm run bench:face` exists but needs a real photo corpus).
- The Aadhaar Secure QR is decoded but its UIDAI signature is not verified (no bundled certificate).
- No TLS, no real OTP delivery, plaintext SQLite at rest, `RETENTION_DAYS` unenforced — demo posture, documented in the README.
- `verified_demo` records are not government credentials; nothing here performs government authentication.

## 9. Commands

```bash
npm start                                   # http://localhost:3000 (uses .env)
NODE_ENV=test node --test                   # the full suite (282 tests, offline)
node scripts/make-live-fixtures.js <dir>    # regenerate the synthetic live-test cards
npm run check:models                        # verify the Workers AI models still exist
```
