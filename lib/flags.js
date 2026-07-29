'use strict';

// Feature flags, so every phase of the rebuild ships independently revertible
// and the master safety switch can be thrown without a code change.
//
// ISSUANCE IS OFF BY DEFAULT. It stays off until, and only until:
//   1. the ownership chain is enforced and the cross-application isolation
//      suite passes with zero leakage;
//   2. the page-aware capability registry rejects fields a document cannot
//      carry (no hallucinated passport parents/address reaching consensus);
//   3. the decision policy is in place and any integrity signal provably
//      blocks issuance.
// Turning this on without those is how a contaminated credential gets minted.

const bool = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
};

const flags = {
  // Master safety switch. Off by default; see above.
  issuanceEnabled: bool('ENABLE_ISSUANCE', false),

  // Reject any field the document/page schema says the document cannot carry.
  enforceCapabilities: bool('ENFORCE_CAPABILITIES', true),

  // Refuse any comparison containing a document owned by another application.
  enforceOwnership: bool('ENFORCE_OWNERSHIP', true),

  // Block comparison until every selected document reaches a final state.
  enforceComparisonBarrier: bool('ENFORCE_COMPARISON_BARRIER', true),

  // Reject images that fail the quality gate rather than extracting from them.
  enforceQualityGate: bool('ENFORCE_QUALITY_GATE', true),

  // Folder / ZIP / multi-page PDF discovery.
  bulkUpload: bool('ENABLE_BULK_UPLOAD', true),

  // Local OCR cross-read (Tesseract / PP-OCR) alongside the vision models.
  deterministicCrossRead: bool('ENABLE_DETERMINISTIC_CROSS_READ', true)
};

/** Why issuance is blocked, or '' when it is permitted. */
function issuanceBlockReason() {
  if (!flags.issuanceEnabled) {
    return 'Golden ID issuance is disabled pending identity-isolation sign-off. '
      + 'Extraction and comparison are available; minting is not.';
  }
  return '';
}

module.exports = { flags, issuanceBlockReason };
