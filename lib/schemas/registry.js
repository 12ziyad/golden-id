'use strict';

// Document capability registry: country -> document type -> page role.
//
// This is the structural defence against hallucination. The live database
// contained a passport extraction carrying a father_name, a mother_name AND an
// address — a passport bio page prints none of those. The old design accepted
// whatever the model returned, and the comparison matrix then treated the
// passport as a legitimate voter on parent names, so an invented value could
// become the consensus value on an issued credential.
//
// Two enforcement points, because prompting alone is not a control:
//   1. the prompt only ASKS for fields the page can carry;
//   2. the backend REJECTS anything outside that set even if the model emits it.
//
// Structured as generic categories first, then country/layout specialisations,
// so adding a new country is data rather than code.

const ALL_FIELDS = [
  'holder_name', 'surname', 'given_names',
  'father_name', 'mother_name', 'spouse_name',
  'dob', 'year_of_birth', 'age', 'gender',
  'address', 'place_of_birth',
  'document_number', 'issue_date', 'expiry_date',
  'nationality', 'issuing_authority', 'mrz'
];

// Generic, country-agnostic capabilities. A country entry overrides these.
const GENERIC = {
  passport: {
    label: 'Passport',
    pages: {
      front: {
        // The bio/data page. This is what people scan.
        allowed: ['holder_name', 'surname', 'given_names', 'document_number', 'nationality',
          'dob', 'gender', 'place_of_birth', 'issue_date', 'expiry_date', 'issuing_authority', 'mrz'],
        required: ['holder_name', 'document_number', 'dob'],
        // Parents and spouse live on the back page; there is NO residential
        // address on a passport bio page, only a place of birth.
        impossible: ['father_name', 'mother_name', 'spouse_name', 'address']
      },
      back: {
        allowed: ['father_name', 'mother_name', 'spouse_name', 'address'],
        required: [],
        impossible: ['document_number', 'mrz', 'place_of_birth']
      }
    }
  },

  national_id: {
    label: 'National ID',
    pages: {
      front: {
        allowed: ['holder_name', 'dob', 'year_of_birth', 'gender', 'document_number', 'address'],
        required: ['holder_name', 'document_number'],
        impossible: ['mrz', 'expiry_date']
      },
      back: {
        allowed: ['address', 'document_number', 'father_name'],
        required: [],
        impossible: ['mrz']
      }
    }
  },

  tax_id: {
    label: 'Tax ID',
    pages: {
      front: {
        allowed: ['holder_name', 'father_name', 'mother_name', 'dob', 'document_number'],
        required: ['holder_name', 'document_number'],
        impossible: ['gender', 'address', 'mrz', 'expiry_date']
      }
    }
  },

  voter_id: {
    label: 'Voter ID',
    pages: {
      front: {
        allowed: ['holder_name', 'father_name', 'spouse_name', 'dob', 'year_of_birth', 'age', 'gender', 'document_number'],
        required: ['holder_name', 'document_number'],
        impossible: ['mrz', 'expiry_date']
      },
      back: {
        allowed: ['address', 'issue_date'],
        required: [],
        impossible: ['mrz']
      }
    }
  },

  driving_licence: {
    label: 'Driving Licence',
    pages: {
      front: {
        allowed: ['holder_name', 'father_name', 'dob', 'gender', 'address', 'document_number', 'issue_date', 'expiry_date', 'issuing_authority'],
        required: ['holder_name', 'document_number'],
        impossible: ['mrz', 'mother_name']
      }
    }
  },

  birth_certificate: {
    label: 'Birth Certificate',
    pages: {
      front: {
        allowed: ['holder_name', 'father_name', 'mother_name', 'dob', 'gender', 'place_of_birth', 'document_number', 'issue_date', 'issuing_authority', 'address'],
        required: ['dob'],
        impossible: ['mrz', 'expiry_date', 'spouse_name']
      }
    }
  }
};

// Country specialisations. `type` maps the local name onto a generic category.
const COUNTRIES = {
  IN: {
    label: 'India',
    documents: {
      pan: {
        category: 'tax_id',
        label: 'PAN Card',
        pages: {
          front: {
            allowed: ['holder_name', 'father_name', 'mother_name', 'dob', 'document_number'],
            required: ['holder_name', 'document_number'],
            // A PAN card prints neither. Observed hallucinated in the wild.
            impossible: ['gender', 'address', 'mrz', 'expiry_date', 'spouse_name', 'place_of_birth']
          }
        }
      },
      aadhaar: {
        category: 'national_id',
        label: 'Aadhaar Card',
        pages: {
          front: {
            allowed: ['holder_name', 'dob', 'year_of_birth', 'gender', 'document_number', 'address'],
            required: ['holder_name', 'document_number'],
            // Aadhaar does not print a parent's name. The only exception is an
            // explicit S/O, D/O or W/O line, handled as `conditional` below.
            impossible: ['mother_name', 'mrz', 'expiry_date', 'place_of_birth'],
            conditional: {
              // Allowed only when the printed guardian marker is visible.
              father_name: { requiresEvidence: /\b(S\s*\/\s*O|D\s*\/\s*O|W\s*\/\s*O|father)\b/i },
              spouse_name: { requiresEvidence: /\b(W\s*\/\s*O|husband|spouse)\b/i }
            }
          },
          back: {
            allowed: ['address', 'document_number'],
            required: [],
            impossible: ['mrz', 'gender']
          }
        }
      },
      passport: {
        category: 'passport',
        label: 'Passport'
      },
      voter: {
        category: 'voter_id',
        label: 'Voter ID'
      },
      birth_certificate: {
        category: 'birth_certificate',
        label: 'Birth Certificate'
      },
      driving_licence: {
        category: 'driving_licence',
        label: 'Driving Licence'
      }
    }
  }
};

const DEFAULT_COUNTRY = 'IN';

/**
 * Resolve the capability sheet for a document type and page role.
 * Falls back through: country override -> generic category -> permissive unknown.
 */
function capabilitiesFor(docType, pageRole = 'front', country = DEFAULT_COUNTRY) {
  const countryEntry = COUNTRIES[country] || COUNTRIES[DEFAULT_COUNTRY];
  const specific = countryEntry && countryEntry.documents ? countryEntry.documents[docType] : null;

  // A country-specific page definition wins outright.
  if (specific && specific.pages && specific.pages[pageRole]) {
    return { ...specific.pages[pageRole], docType, pageRole, country, label: specific.label, known: true };
  }

  // Otherwise fall back to the generic category this document belongs to.
  const category = (specific && specific.category) || docType;
  const generic = GENERIC[category];
  if (generic && generic.pages && generic.pages[pageRole]) {
    return {
      ...generic.pages[pageRole], docType, pageRole, country,
      label: (specific && specific.label) || generic.label, known: true
    };
  }

  // Unknown document: nothing is forbidden, nothing is required, and nothing
  // is trusted. We do not guess a capability sheet we do not have.
  return {
    allowed: ALL_FIELDS, required: [], impossible: [], conditional: {},
    docType, pageRole, country, label: 'Unrecognised document', known: false
  };
}

/** True when this document/page may legitimately carry the field. */
function canCarry(docType, field, pageRole = 'front', country = DEFAULT_COUNTRY) {
  const sheet = capabilitiesFor(docType, pageRole, country);
  if ((sheet.impossible || []).includes(field)) return false;
  if ((sheet.allowed || []).includes(field)) return true;
  return Boolean(sheet.conditional && sheet.conditional[field]);
}

/** True when the field is forbidden outright — a model emitting it hallucinated. */
const isImpossible = (docType, field, pageRole = 'front', country = DEFAULT_COUNTRY) =>
  (capabilitiesFor(docType, pageRole, country).impossible || []).includes(field);

/** Fields the page must supply for the read to be considered complete. */
const requiredFields = (docType, pageRole = 'front', country = DEFAULT_COUNTRY) =>
  capabilitiesFor(docType, pageRole, country).required || [];

/**
 * A field allowed only when supporting text is visible on the page (an Aadhaar
 * "S/O" line, for instance). Returns the rule, or null.
 */
function conditionalRule(docType, field, pageRole = 'front', country = DEFAULT_COUNTRY) {
  const sheet = capabilitiesFor(docType, pageRole, country);
  return (sheet.conditional && sheet.conditional[field]) || null;
}

/** Every document type the registry knows, for prompt and UI generation. */
function knownTypes(country = DEFAULT_COUNTRY) {
  const entry = COUNTRIES[country] || COUNTRIES[DEFAULT_COUNTRY];
  return Object.keys(entry.documents || {});
}

module.exports = {
  ALL_FIELDS, GENERIC, COUNTRIES, DEFAULT_COUNTRY,
  capabilitiesFor, canCarry, isImpossible, requiredFields, conditionalRule, knownTypes
};
