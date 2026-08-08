# Golden ID — backend flow, in plain terms

Three diagrams. The first is what happens, the second is where the code lives,
the third is the actual conversation between the parts.

---

## 1. What happens, start to finish

```mermaid
flowchart LR
    A["1 · Sign in<br/>phone or email + one-time code"] --> B["2 · Start an application<br/>an empty folder for this person"]
    B --> C["3 · Upload documents<br/>each one is read"]
    C --> D["4 · Compare<br/>do the documents agree?"]
    D --> E{"Do they?"}
    E -->|yes| F["5 · Golden ID issued<br/>signed and shareable"]
    E -->|"tiny spelling difference"| G["Ask the person<br/>same you? confirm"]
    E -->|"real conflict"| H["Blocked<br/>needs a human"]
    G --> F

    style F fill:#1f4d2b,color:#fff
    style H fill:#7a2323,color:#fff
```

An **application** is the boundary that matters: a document belongs to exactly
one application, and nothing can ever reach across from another.

---

## 2. Where the code lives

```mermaid
flowchart TD
    CLIENT["Browser or any HTTP client"] --> SERVER

    SERVER["<b>server.js</b><br/>routes · login · rate limits<br/>knows nothing about identity"]
    SERVER --> WORK["<b>lib/application.js</b> — the workflow<br/>ingest · compare · confirm · issue<br/>every method checks who owns what"]

    WORK --> EX["<b>lib/extract</b><br/>read the document"]
    WORK --> CO["<b>lib/compare</b><br/>do they describe one person?"]
    WORK --> RE["<b>lib/record</b><br/>sign and issue the ID"]

    EX --> AI{{"Cloudflare AI · 2 models<br/>+ local OCR + QR/MRZ"}}
    RE --> KEY{{"Ed25519 signing key"}}

    EX --> DB
    CO --> DB
    RE --> DB
    WORK --> DB[("SQLite<br/>users → applications → documents")]

    style WORK fill:#25406b,color:#fff
```

Read it top to bottom: **HTTP layer** never touches identity logic, the
**workflow** owns every rule about ownership and consent, the **engines** do
one job each, and everything lands in one small database.

---

## 3. The two calls that matter

```mermaid
sequenceDiagram
    participant C as Client
    participant S as server.js
    participant W as Workflow
    participant X as Extraction
    participant AI as AI + OCR
    participant DB as SQLite

    Note over C,DB: Uploading documents
    C->>S: POST /documents with photos
    S->>S: signed in? consent given? under rate limit?
    S->>W: ingest
    W->>DB: seen these exact bytes before?
    DB-->>W: no, this one is new
    W->>DB: create document row, status pending
    W->>X: read it
    X->>AI: QR, then OCR, then 2 vision models
    AI-->>X: values plus evidence for each
    X->>DB: save extraction, never rewritten
    W-->>C: documents and what was read

    Note over C,DB: Comparing them
    C->>S: POST /compare with the exact document ids
    S->>W: compare
    W->>DB: load ONLY those documents, must be mine and active
    W->>W: which values agree, which conflict
    W->>DB: save the verdict and an audit entry
    alt verified
        W->>DB: mint signed Golden ID
        W-->>C: 201 with the ID
    else needs confirmation
        W-->>C: 422 and what to confirm
    else conflict
        W-->>C: 422 blocked, reason given
    end
```

---

## The API in one table

| Call | What it does |
|---|---|
| `POST /auth/request-otp` → `verify-otp` | Sign in, get a session token |
| `POST /applications` | Start a fresh application |
| `GET /applications/:id` | Resume it later — this is what a refresh uses |
| `POST /applications/:id/documents` | Upload and read documents |
| `PATCH /…/documents/:docId/field` | Correct one field by hand |
| `DELETE /…/documents/:docId` | Remove a document from the application |
| `POST /applications/:id/compare` | Compare the documents you name |
| `POST /applications/:id/confirmations` | "Yes, that's the same person" |
| `GET /applications/:id/verdict` | Fetch the last result |
| `POST /records/:gid/share` | Make a limited, expiring share link |
| `GET /cards/:gid?token=…` | A verifier reads only the shared fields |
| `GET /.well-known/golden-id-key` | Public key, so anyone can check the signature |

---

## Four rules the backend never breaks

1. A document is reachable **only** through the application that owns it.
2. What was read from a document is **never edited** — corrections live apart.
3. Only values we could actually **verify** are allowed to agree or disagree.
4. Anything the applicant typed themselves is labelled as such, always.
