'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeDate } = require('../lib/normalize/date');
const { normalizeGender } = require('../lib/normalize/gender');
const { normalizeName } = require('../lib/normalize/name');
const { normalizeAddress } = require('../lib/normalize/address');

test('date: every printed format the documents use normalizes to one ISO value', () => {
  const inputs = ['12/08/1997', '12-08-1997', '12.08.1997', '1997-08-12', '12 Aug 1997', '12-AUG-1997'];
  for (const input of inputs) {
    assert.equal(normalizeDate(input).iso, '1997-08-12', `failed for ${input}`);
  }
});

test('date: two-digit years expand around a sane pivot', () => {
  assert.equal(normalizeDate('12/08/97').iso, '1997-08-12');
  assert.equal(normalizeDate('12/08/05').iso, '2005-08-12');
});

test('date: OCR spacing around separators is tolerated', () => {
  assert.equal(normalizeDate('21 / 05 / 1990').iso, '1990-05-21');
});

test('date: keeps the original alongside the normalized value', () => {
  const result = normalizeDate('12-08-1997');
  assert.equal(result.original, '12-08-1997');
  assert.equal(result.iso, '1997-08-12');
});

test('date: reads DD/MM by default but flags the genuinely ambiguous case', () => {
  const ambiguous = normalizeDate('05/06/1990');
  assert.equal(ambiguous.iso, '1990-06-05', 'defaults to DD/MM as Indian documents print');
  assert.equal(ambiguous.ambiguous, true);

  const unambiguous = normalizeDate('21/05/1990');
  assert.equal(unambiguous.ambiguous, false, 'day > 12 disambiguates on its own');
});

test('date: refuses to guess rather than inventing a value', () => {
  assert.equal(normalizeDate('not a date').iso, null);
  assert.equal(normalizeDate('32/13/1990').iso, null);
  assert.equal(normalizeDate('').iso, null);
});

test('gender: initials, words and bilingual values fold to one code', () => {
  for (const male of ['M', 'Male', 'MALE', 'पुरुष', 'पुरुष / MALE']) {
    assert.equal(normalizeGender(male), 'M', `failed for ${male}`);
  }
  for (const female of ['F', 'Female', 'FEMALE', 'महिला', 'महिला / FEMALE']) {
    assert.equal(normalizeGender(female), 'F', `failed for ${female}`);
  }
  assert.equal(normalizeGender('Transgender'), 'O');
});

test('gender: absent stays distinguishable from "other"', () => {
  assert.equal(normalizeGender(''), '');
  assert.equal(normalizeGender(null), '');
});

test('name: ordering variation produces an identical comparison key', () => {
  const a = normalizeName('MUHAMMED SAKIR K');
  const b = normalizeName('K MUHAMMED SAKIR');
  assert.equal(a.sorted, b.sorted);
  assert.notEqual(a.ordered, b.ordered, 'display order is preserved');
});

test('name: honorifics and punctuation are stripped', () => {
  assert.equal(normalizeName('Mr. Asha  Devi').ordered, 'ASHA DEVI');
  assert.equal(normalizeName('SHRI RAM K.').ordered, 'RAM K');
});

test('name: abbreviations expand as alternates, never as replacements', () => {
  const result = normalizeName('MD SAKIR');
  assert.equal(result.ordered, 'MD SAKIR', 'the printed form is untouched');
  assert.ok(result.alternates.includes('MUHAMMED SAKIR'));
  assert.ok(result.alternates.includes('MOHAMMED SAKIR'));
});

test('address: cleaned, with a postal code and components pulled out', () => {
  const result = normalizeAddress('  12 mg road ,, bengaluru  560001 ');
  assert.equal(result.postalCode, '560001');
  assert.match(result.text, /^12 MG ROAD, BENGALURU 560001$/);
});
