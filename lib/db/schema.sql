-- Golden ID prototype storage.
--
-- Everything here is local demo storage. Before production this needs
-- encryption at rest, key management, retention limits and a real migration
-- tool. It is NOT a government system of record.
--
-- OWNERSHIP CHAIN. The original schema keyed extractions by file bytes alone,
-- with no user or application column anywhere. That is what let one applicant's
-- PAN and Aadhaar appear inside another applicant's comparison. Every row that
-- can carry identity now hangs off this chain, and every query that reads
-- identity data must filter on it:
--
--   users -> applications -> upload_batches -> documents -> logical_documents
--                                     |            |
--                                     |            +-> face_embeddings
--                                     |            +-> corrections
--                                     +-> comparisons -> records (gid)
--
-- `extractions` is deliberately OUTSIDE that chain: it is byte-scoped compute,
-- immutable, and carries no ownership. A cache hit reuses the extraction but
-- always creates a fresh, owned `documents` row for the current application.

-- A signed-in person. Previously only an in-memory session map existed, so
-- there was no durable identity to attribute anything to.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,     -- email or phone used for OTP
  created_at TEXT NOT NULL
);

-- One identity-check run, owned by exactly one user.
CREATE TABLE IF NOT EXISTS applications (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'open',
  decision           TEXT NOT NULL DEFAULT '',
  gid                TEXT,
  created_at         TEXT NOT NULL,
  closed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_applications_user ON applications (user_id);

-- One discovery run (a drop of files, a folder, or a ZIP).
CREATE TABLE IF NOT EXISTS upload_batches (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  source         TEXT NOT NULL DEFAULT 'files',   -- files | folder | zip | pdf
  file_count     INTEGER NOT NULL DEFAULT 0,
  byte_size      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_application ON upload_batches (application_id);

-- THE ownership-scoped reference to one uploaded file. This is what comparison
-- resolves against; a raw content hash from the client is never trusted.
CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  upload_batch_id TEXT NOT NULL REFERENCES upload_batches (id) ON DELETE CASCADE,
  content_hash    TEXT NOT NULL,
  extraction_key  TEXT,                            -- FK into extractions (versioned key)
  file_name       TEXT NOT NULL DEFAULT '',
  relative_path   TEXT NOT NULL DEFAULT '',
  detected_mime   TEXT NOT NULL DEFAULT '',        -- sniffed from BYTES, not the client header
  byte_size       INTEGER NOT NULL DEFAULT 0,
  page_number     INTEGER NOT NULL DEFAULT 1,
  page_role       TEXT NOT NULL DEFAULT 'front',   -- front | back | page
  doc_type        TEXT NOT NULL DEFAULT 'unknown',
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|preprocessing|extracting|ready|unreadable|retake_required|rejected_file|removed_by_user
  status_reason   TEXT NOT NULL DEFAULT '',
  quality         TEXT NOT NULL DEFAULT '{}',      -- JSON: blur/glare/resolution/orientation
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_application ON documents (application_id);
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents (content_hash);
CREATE INDEX IF NOT EXISTS idx_documents_batch ON documents (upload_batch_id);

-- Immutable, deduplicated extraction compute. Keyed by the file bytes AND the
-- versions of everything that produced the result, so changing a prompt or a
-- model does not silently serve a stale read. Carries NO ownership, NO
-- overrides, NO face, NO consensus, NO comparison state.
CREATE TABLE IF NOT EXISTS extractions (
  extraction_key  TEXT PRIMARY KEY,   -- sha256(bytes|extractor|prompt_ver|schema_ver|model_ids)
  content_hash    TEXT NOT NULL,
  extractor       TEXT NOT NULL DEFAULT '',
  prompt_version  TEXT NOT NULL DEFAULT '',
  schema_version  TEXT NOT NULL DEFAULT '',
  model_ids       TEXT NOT NULL DEFAULT '',
  raw_fields      TEXT NOT NULL DEFAULT '{}',   -- JSON: per-field evidence envelopes, immutable
  field_states    TEXT NOT NULL DEFAULT '{}',   -- JSON: present_verified | present_uncertain | not_present | unreadable | invalid
  doc_type        TEXT NOT NULL DEFAULT 'unknown',
  confidence      TEXT NOT NULL DEFAULT '{}',
  candidates      TEXT NOT NULL DEFAULT '{}',
  validation      TEXT NOT NULL DEFAULT '{}',
  classification  TEXT NOT NULL DEFAULT '{}',
  source          TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extractions_hash ON extractions (content_hash);

-- Front/back/multi-page grouping, scoped to one application so pages from two
-- different people can never be merged into one logical document.
CREATE TABLE IF NOT EXISTS logical_documents (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  doc_type       TEXT NOT NULL DEFAULT 'unknown',
  document_ids   TEXT NOT NULL DEFAULT '[]',     -- JSON array of documents.id
  grouping       TEXT NOT NULL DEFAULT '{}',     -- JSON: why these pages were grouped
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logical_application ON logical_documents (application_id);

-- Face embeddings are OWNED, not stored on the byte-keyed extraction row.
CREATE TABLE IF NOT EXISTS face_embeddings (
  document_id    TEXT PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  embedding      TEXT NOT NULL DEFAULT '[]',
  box            TEXT NOT NULL DEFAULT '[]',
  quality        TEXT NOT NULL DEFAULT '{}',
  detector       TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faces_application ON face_embeddings (application_id);

-- Holder corrections, attributed and owned, never mutating raw extraction.
CREATE TABLE IF NOT EXISTS corrections (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  document_id    TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  field          TEXT NOT NULL,
  value          TEXT,
  actor          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_document ON corrections (document_id);
CREATE INDEX IF NOT EXISTS idx_corrections_application ON corrections (application_id);

-- One comparison run over a stable set of documents.
CREATE TABLE IF NOT EXISTS comparisons (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  document_ids   TEXT NOT NULL DEFAULT '[]',
  verdict        TEXT NOT NULL DEFAULT '{}',
  decision       TEXT NOT NULL DEFAULT '',
  integrity      TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comparisons_application ON comparisons (application_id);

-- Issued Golden IDs.
CREATE TABLE IF NOT EXISTS records (
  gid            TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications (id) ON DELETE SET NULL,
  user_id        TEXT REFERENCES users (id) ON DELETE SET NULL,
  record         TEXT NOT NULL,
  signature      TEXT NOT NULL DEFAULT '',
  dedup_hash     TEXT NOT NULL DEFAULT '',
  revoked        INTEGER NOT NULL DEFAULT 0,
  revoked_at     TEXT,
  revoked_reason TEXT NOT NULL DEFAULT '',
  issued_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_dedup ON records (dedup_hash);
CREATE INDEX IF NOT EXISTS idx_records_application ON records (application_id);

-- A person's document numbers, so the same card cannot back a second Golden ID.
CREATE TABLE IF NOT EXISTS document_numbers (
  number   TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  gid      TEXT NOT NULL,
  PRIMARY KEY (number, doc_type)
);
CREATE INDEX IF NOT EXISTS idx_document_numbers_number ON document_numbers (number);
CREATE INDEX IF NOT EXISTS idx_document_numbers_gid ON document_numbers (gid);

-- Short-lived, scoped retrieval tokens.
CREATE TABLE IF NOT EXISTS share_tokens (
  token      TEXT PRIMARY KEY,
  gid        TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT '[]',
  single_use INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_gid ON share_tokens (gid);

-- Every retrieval, issuance, correction and integrity block.
CREATE TABLE IF NOT EXISTS audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  gid            TEXT NOT NULL DEFAULT '',
  application_id TEXT NOT NULL DEFAULT '',
  user_id        TEXT NOT NULL DEFAULT '',
  action         TEXT NOT NULL,
  actor          TEXT NOT NULL DEFAULT '',
  detail         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_gid ON audit (gid);
CREATE INDEX IF NOT EXISTS idx_audit_application ON audit (application_id);
