# Golden ID — Extraction Architecture

How a photograph of an identity document becomes evidence, and what stops it
from becoming a guess. Every diagram below reflects the code as it actually
runs (`EXTRACTOR_VERSION 3.2.0`).

---

## 1. System overview

```mermaid
flowchart LR
    subgraph clients["Clients"]
        UI["Browser SPA<br/>public/app.js"]
        EXT["Any HTTP client<br/>scripts/api-demo.js"]
    end

    subgraph http["HTTP layer — server.js"]
        AUTH["OTP → bearer session<br/>rate limits"]
        ROUTES["/api/v1 routes<br/>ownership on every path"]
    end

    subgraph flow["Workflow — lib/application.js"]
        ING["ingest()<br/>dedup · discover · register"]
        CMP["compare()<br/>explicit documentIds"]
        CONF["confirmVariation()"]
        ISS["issue()"]
    end

    subgraph engine["Engines"]
        EX["Extraction<br/>lib/extract/*"]
        CO["Comparison<br/>lib/compare/*"]
        RE["Record<br/>lib/record/*"]
    end

    DB[("SQLite<br/>lib/db")]
    CF{{"Cloudflare Workers AI<br/>moondream + llama"}}

    UI --> ROUTES
    EXT --> ROUTES
    ROUTES --> AUTH
    ROUTES --> ING & CMP & CONF & ISS
    ING --> EX
    CMP --> CO
    ISS --> RE
    EX <--> CF
    EX & CO & RE <--> DB
```

---

## 2. The extraction pipeline — `extractOne()`

The order is deliberate: **cheap and certain first, expensive and fallible
last.** Deterministic sources (QR, MRZ) are read before any model, so a model
can never override checksummed truth.

```mermaid
flowchart TD
    START(["buffer + mimeType"]) --> KEY["Compute extraction key<br/>sha256(bytes + extractor + prompt + schema + models)"]
    KEY --> CACHE{"Cached?"}
    CACHE -->|hit| CACHED["Return cached extraction<br/>quality-gate verdict preserved"]
    CACHE -->|miss| NORM["2 · Normalise image<br/>EXIF rotate · max 2400px · JPEG q92"]

    NORM --> QUAL["Assess quality<br/>sharpness · glare · exposure · contrast · resolution"]
    QUAL --> TIER{"Tier?"}
    TIER -->|unusable| GATE["3 · Quality gate<br/>save empty extraction<br/>status: retake_required"]
    GATE --> RETAKE(["Specific reason + camera guidance"])

    TIER -->|good| QR
    TIER -->|marginal| QR

    QR["4 · Aadhaar Secure QR<br/>zxing-wasm → inflate → fields"] --> OCR["5 · Local OCR — tesseract eng+hin<br/>INDEPENDENT of the model"]

    OCR --> MARGINAL{"tier == marginal?"}
    MARGINAL -->|yes| ENH["5b · Blur recovery<br/>≤3 enhancement variants<br/>one OCR pass each"]
    MARGINAL -->|no| MRZ
    ENH --> MRZ["Parse MRZ from every OCR text<br/>ICAO 9303 check digits"]

    MRZ --> CLS1["6 · Classify from evidence<br/>weighted votes, margin ≥ 3"]
    CLS1 --> VIS{"Vision configured<br/>and not a text upload?"}
    VIS -->|no| FALLBACK["9 · OCR-only extraction"]
    VIS -->|yes| ID

    ID["7a · IDENTIFY pass<br/>generic prompt, 18 fields"] --> FOCUS["7b · FOCUSED read<br/>type-specific prompt, 5-6 fields<br/>kept only if it scores ≥ identify"]
    FOCUS --> CLS2["8 · Re-classify on what was read"]
    CLS2 --> XCHECK{"Cross-check needed?<br/>always · required field unverified · type unsure"}
    XCHECK -->|yes| SECOND["Second model<br/>llama-3.2-11b-vision"]
    XCHECK -->|no| MERGE
    SECOND --> MERGE

    FALLBACK --> MERGE["Merge readings<br/>same value → verified<br/>disagree → uncertain + candidates"]

    MERGE --> DET["10 · Deterministic overwrite<br/>QR / MRZ values win outright @0.99"]
    DET --> CLS3["11 · Final classification"]
    CLS3 --> REASSESS["Re-assess every field<br/>against the now-known type<br/>upgrades only"]

    REASSESS --> CONSENSUS["11b · OCR-consensus recovery<br/>value seen in ≥2 independent OCR texts<br/>under its label → verified"]
    CONSENSUS --> REREAD["11c · Targeted field re-read<br/>≤3 uncertain identity fields<br/>single-field prompt, 'return null, do not guess'"]

    REREAD --> PERSIST["12 · Persist immutable extraction<br/>rawFields · fieldStates · validation · classification"]
    PERSIST --> DONE(["Extraction record"])

    style GATE fill:#7a2323,color:#fff
    style DET fill:#1f4d2b,color:#fff
    style CONSENSUS fill:#1f4d2b,color:#fff
    style PERSIST fill:#25406b,color:#fff
```

### Why each stage exists

| Stage | Exists because |
|---|---|
| Cache by bytes **and** versions | A prompt or model change must never serve a stale read |
| Quality gate (unusable only) | Never read what cannot be seen — but never reject what recovery might rescue |
| QR / MRZ **before** models | Checksummed truth outranks any model; reading it first makes that structural |
| Local OCR as corroboration | The only witness independent of the model — this is what caught an invented DOB on a real Voter ID |
| Identify → focused (two prompts) | Asking a small model for 18 fields loses fields; asking for 6 does not |
| Cross-check model | Two independent readings agreeing is real evidence; one model's word is not |
| Consensus + re-read | Real phone photos defeat local OCR; a second independent look rescues correct reads without trusting a single claim |

---

## 3. Blur recovery (the `marginal` path)

```mermaid
flowchart LR
    ORIG[("Stored original<br/>never modified")] -.->|"read-only source"| IMG
    IMG["Normalised image"] --> M{"Which metric failed?"}
    M -->|"soft (sharpness < 55)"| S["sharpen σ1.2"]
    M -->|"flat (contrast < 18)"| C["CLAHE 64×64"]
    M -->|"glare / dark"| C
    M -->|"small (width < 1100)"| U["upscale 2×"]
    M -->|always| G["greyscale + normalise"]

    S & C & U & G --> CAP["≤ 3 variants, in memory only"]
    CAP --> OCRV["One tesseract pass per variant"]
    OCRV --> POOL[("Pool of independent OCR texts")]
    POOL --> RULE{"Value present in ≥2 texts<br/>under its field label?"}
    RULE -->|yes| VER["present_verified<br/>reason: verified_by_ocr_consensus"]
    RULE -->|no| UNC["stays uncertain →<br/>targeted re-read, then honest label"]
```

**Honest limits.** Slight blur and compression are often recoverable. Moderate
blur yields uncertain evidence. Severe blur, glare, missing pixels or tiny
text are **not** recoverable — enhancement sharpens what the sensor captured;
it cannot recreate detail that was never captured.

---

## 4. How a value becomes a state — `assessField()`

Every field passes this ladder exactly once. First match wins.

```mermaid
flowchart TD
    V(["field value from a reader"]) --> EMPTY{"empty?"}
    EMPTY -->|yes| NP1["not_present<br/>no_value_returned"]
    EMPTY -->|no| SELF{"source is QR / MRZ /<br/>deterministic?"}
    SELF -->|yes| PV1["present_verified<br/>self_evident_source"]
    SELF -->|no| FMT{"format + checksum valid?<br/>Verhoeff · PAN · EPIC · passport"}
    FMT -->|yes| PV2["present_verified<br/>format_and_checksum_valid"]
    FMT -->|no| PAGE{"value in independent OCR text<br/>AND a label for the field?"}
    PAGE -->|yes| PV3["present_verified<br/>corroborated_by_page_text"]
    PAGE -->|no| CROSS{"second model produced<br/>the same value + label?"}
    CROSS -->|yes| PV4["present_verified<br/>confirmed_by_second_model"]
    CROSS -->|no| SNIP{"model's own evidence snippet<br/>contains the value + label?"}
    SNIP -->|yes| VETO{"Can OCR witness absence?<br/>i.e. did OCR read ANY real label?"}
    VETO -->|"yes, and value absent"| PU1["present_uncertain<br/>evidence_not_found_in_page_text"]
    VETO -->|no| PV5["present_verified<br/>evidence_supports_value"]
    SNIP -->|no| REQ{"required + self-identifying?<br/>name · number · gender"}
    REQ -->|yes| PV6["present_verified<br/>required_field_read_from_document"]
    REQ -->|no| LABEL{"no label anywhere —<br/>but can OCR witness that?"}
    LABEL -->|"OCR readable: label truly absent"| NP2["not_present<br/>no_label_for_field_on_page"]
    LABEL -->|"OCR was garbage: cannot judge"| PU2["present_uncertain<br/>no_local_corroboration_available"]
    LABEL -->|"label present, value untied"| PU3["present_uncertain<br/>value_without_supporting_evidence"]

    style PV1 fill:#1f4d2b,color:#fff
    style PV2 fill:#1f4d2b,color:#fff
    style PV3 fill:#1f4d2b,color:#fff
    style PV4 fill:#1f4d2b,color:#fff
    style PV5 fill:#1f4d2b,color:#fff
    style PV6 fill:#1f4d2b,color:#fff
    style NP2 fill:#5a4a1f,color:#fff
    style PU2 fill:#5a4a1f,color:#fff
```

> The `VETO` and `LABEL` branches are the fix for real photographs: local OCR
> that could not read a single field label off the page is **noise**, and
> noise is not allowed to testify that a value is absent.

---

## 5. Field states

```mermaid
stateDiagram-v2
    [*] --> read: a reader returns a value

    read --> present_verified: evidence ladder satisfied
    read --> present_uncertain: value, but nothing ties it to the page
    read --> not_present: page demonstrably lacks the field
    read --> unreadable: expected, image defeats reading
    read --> invalid: impossible for this document type, or failed validation

    present_uncertain --> present_verified: OCR consensus (≥2 variants)
    present_uncertain --> present_verified: targeted single-field re-read agrees
    unreadable --> present_verified: recovered after enhancement

    note right of present_verified
        ONLY this state participates in
        document-to-document comparison.
    end note

    note right of invalid
        Raw value is still retained,
        so a hallucination stays auditable.
    end note
```

A sixth state, **`holder_asserted`**, is produced by the database layer (not
by extraction) when the applicant types a value the document never showed. It
displays, it can unblock a required field, and it **never** counts as document
evidence.

---

## 6. Evidence strength ladder

Used to pick a cluster winner: strongest source first, total weight second.

```mermaid
flowchart LR
    A["barcode / MRZ<br/>1.00"] --> B["deterministic<br/>0.95"] --> C["vision + crosscheck<br/>0.85"] --> D["embedded text<br/>0.80"] --> E["OCR<br/>0.70"] --> F["single vision model<br/>0.60"] --> G["holder correction<br/>0.50 · never corroborates"]
```

A cluster containing any source ≥ 0.90 wins outright — two model guesses can
never outvote a checksummed read.

---

## 7. Comparison and decision

```mermaid
flowchart TD
    SEL(["explicit documentIds"]) --> GUARD{"unique · owned · active?"}
    GUARD -->|no| ERR["400 / 409 + audit event"]
    GUARD -->|yes| GROUP["Group pages into logical documents<br/>front + back of one card = ONE source"]
    GROUP --> FIELDS["For each comparable field"]

    FIELDS --> G1{"Gate 1 — capability<br/>can this type carry the field?"}
    G1 -->|no| ABST["abstained: not_carried_by_document"]
    G1 -->|yes| G2{"Gate 2 — presence<br/>state == present_verified?"}
    G2 -->|no| ABST2["abstained / unreadable<br/>observed value carried forward"]
    G2 -->|yes| CLUSTER["Cluster values<br/>normalise → merge variants → weigh"]

    CLUSTER --> CORR["corroboration =<br/>distinct logical documents<br/>excluding holder sources"]
    CORR --> DECIDE{"decide()"}

    DECIDE --> D1["blocked_security_integrity"]
    DECIDE --> D2["document_conflict / suspected_cross_identity"]
    DECIDE --> D3["insufficient_evidence"]
    DECIDE --> D4["likely_match_needs_confirmation"]
    DECIDE --> D5["verified_match / _no_conflict / _with_partial_overlap"]

    D4 -->|holder confirms soft variant| RECMP["re-compare same selection"]
    RECMP --> D5
    D5 --> ISSUE["Issue Ed25519-signed record"]

    style D1 fill:#7a2323,color:#fff
    style D2 fill:#7a2323,color:#fff
    style D5 fill:#1f4d2b,color:#fff
```

---

## 8. Module tree

```
lib/
├── application.js          workflow: ingest · compare · confirm · issue
├── config.js  flags.js  ratelimit.js  uploads.js
│
├── extract/                ── THE EXTRACTION ENGINE ──
│   ├── index.js            orchestration (the pipeline in §2)
│   ├── vision.js           Workers AI client + per-model adapters
│   ├── prompts.js          generic · type-specific · single-field re-read
│   ├── tesseract.js        local OCR (eng + hin) and label parsing
│   ├── classify.js         weighted-evidence document typing
│   ├── evidence.js         assessField — the ladder in §4
│   └── schema.js           envelopes · validation · reassess · JSON salvage
│
├── preprocess/
│   ├── index.js            MIME sniff · quality metrics · tiers · crop
│   └── enhance.js          blur-recovery variants (§3)
│
├── validate/
│   ├── formats.js          Aadhaar · PAN · EPIC · passport patterns
│   ├── checksums.js        Verhoeff · MRZ ICAO 9303
│   ├── repair.js           positional OCR repair
│   └── barcode.js          Aadhaar Secure QR decode
│
├── compare/
│   ├── index.js  cluster.js  decision.js  matrix.js
│   ├── names.js            10-step transliteration-aware cascade
│   ├── levenshtein.js  diff.js
│
├── normalize/              name · date · gender · address
├── schemas/registry.js     what each document type CAN carry
├── upload/                 discover (ZIP/PDF/MIME) · grouping (front/back)
├── face/                   detect · embed · match (advisory only)
├── record/                 consensus · dedup · issue (Ed25519)
└── db/                     index.js · schema.sql
```

---

## 9. Data model

```mermaid
erDiagram
    users ||--o{ applications : owns
    applications ||--o{ upload_batches : has
    applications ||--o{ documents : contains
    applications ||--o{ logical_documents : groups
    applications ||--o{ comparisons : runs
    applications ||--o{ confirmations : records
    applications ||--o{ audit : logs
    upload_batches ||--o{ documents : delivered
    documents ||--o{ corrections : "holder edits"
    documents ||--o| face_embeddings : "photo vector"
    documents }o--|| extractions : "by extraction_key"
    comparisons ||--o| records : issues
    records ||--o{ share_tokens : "scoped access"
    records ||--o{ document_numbers : "backed by"

    extractions {
        text extraction_key PK "bytes + versions"
        text raw_fields "immutable envelopes"
        text field_states "the 5 states"
        text validation "checksums · quality · errors"
    }
    documents {
        text id PK
        text application_id FK "ownership boundary"
        text content_hash "dedup within application"
        text status "pending→ready/unreadable/retake/removed"
    }
```

**`extractions` sits deliberately outside the ownership chain**: it is keyed by
bytes and versions, so identical files are read once and shared — while every
application still gets its own `documents` row that only its owner can reach.

---

## 10. Invariants the design guarantees

1. The uploaded original is **immutable**; every enhancement is a derivative
   held in memory.
2. A stored extraction is **never rewritten** — corrections live in their own
   table and are applied on read.
3. Only `present_verified` participates in comparison.
4. A value the applicant supplied can never be presented as printed evidence,
   and never counts toward document agreement.
5. Corroboration counts **distinct logical documents** — one card can never
   corroborate itself.
6. Checksummed machine-readable evidence outranks every model.
7. Every verified value carries a reason code explaining *how* it was verified.
