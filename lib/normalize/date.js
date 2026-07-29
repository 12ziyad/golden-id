'use strict';

// Indian identity documents print dates as DD/MM/YYYY far more often than any
// other order, so DD/MM is the default reading. Where a value could plausibly be
// either DD/MM or MM/DD we say so rather than silently picking one.

const MONTHS = {
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, APR: 4, APRIL: 4,
  MAY: 5, JUN: 6, JUNE: 6, JUL: 7, JULY: 7, AUG: 8, AUGUST: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9, OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11,
  DEC: 12, DECEMBER: 12
};

const pad = value => String(value).padStart(2, '0');

// Two-digit years: anything after this year's last two digits must belong to the
// previous century. In 2026, "97" is 1997 and "12" is 2012.
function expandYear(year) {
  const digits = Number(year);
  if (String(year).length === 4) return digits;
  const pivot = new Date().getFullYear() % 100;
  return digits > pivot ? 1900 + digits : 2000 + digits;
}

function isRealDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function build(original, year, month, day, ambiguous) {
  if (!isRealDate(year, month, day)) return { iso: null, original, ambiguous: false, reason: 'impossible-date' };
  return { iso: `${year}-${pad(month)}-${pad(day)}`, original, ambiguous, reason: '' };
}

/**
 * Normalize a printed date to ISO `YYYY-MM-DD`, keeping the original for display.
 * Returns `{ iso, original, ambiguous, reason }`; `iso` is null when the input
 * cannot be read as a real date rather than guessing at it.
 */
function normalizeDate(value) {
  const original = String(value == null ? '' : value).trim();
  if (!original) return { iso: null, original: '', ambiguous: false, reason: 'empty' };

  // Collapse spacing OCR leaves around separators: "21 / 05 / 1990".
  const text = original.replace(/\s*([/.\-])\s*/g, '$1').replace(/\s+/g, ' ').toUpperCase();

  // ISO first — an unambiguous four-digit year in the leading position.
  const iso = text.match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/);
  if (iso) return build(original, Number(iso[1]), Number(iso[2]), Number(iso[3]), false);

  // DD MMM YYYY / DD-MMM-YY, in either order around the month name.
  const named = text.match(/^(\d{1,2})[\s.\-/]*([A-Z]{3,9})[\s.\-/]*(\d{2,4})$/);
  if (named && MONTHS[named[2]]) {
    return build(original, expandYear(named[3]), MONTHS[named[2]], Number(named[1]), false);
  }
  const namedFirst = text.match(/^([A-Z]{3,9})[\s.\-/]*(\d{1,2})[,\s.\-/]*(\d{2,4})$/);
  if (namedFirst && MONTHS[namedFirst[1]]) {
    return build(original, expandYear(namedFirst[3]), MONTHS[namedFirst[1]], Number(namedFirst[2]), false);
  }

  // Numeric day/month/year, including two-digit years.
  const numeric = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = expandYear(numeric[3]);
    // Read as DD/MM. Flag when MM/DD would also have been a real date, so a
    // caller can surface the doubt instead of trusting a coin flip.
    const ambiguous = first <= 12 && second <= 12 && first !== second;
    if (first > 12 && second <= 12) return build(original, year, second, first, false);
    if (second > 12 && first <= 12) return build(original, year, first, second, false); // clearly MM/DD
    return build(original, year, second, first, ambiguous);
  }

  // Year only — common on Voter IDs that print an age or year of birth.
  const yearOnly = text.match(/^(\d{4})$/);
  if (yearOnly) return { iso: null, original, ambiguous: false, reason: 'year-only' };

  return { iso: null, original, ambiguous: false, reason: 'unparsed' };
}

/** Convenience: the ISO string, or '' when the value could not be read. */
const toIso = value => normalizeDate(value).iso || '';

module.exports = { normalizeDate, toIso, expandYear };
