'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { levenshtein } = require('../lib/compare/levenshtein');
const { compareNames, VERDICTS, jaroWinkler, damerauLevenshtein, phoneticKey } = require('../lib/compare/names');
const { renderDiff, renderNameDiff } = require('../lib/compare/diff');
const { clusterField } = require('../lib/compare/cluster');
const { compareDocuments } = require('../lib/compare');
const { DECISIONS, ISSUABLE } = require('../lib/compare/decision');
const matrix = require('../lib/compare/matrix');

// Every document in a comparison is a READY, owned document with a page role.
const document = (type, fields, extra = {}) => ({
  id: `doc-${type}-${Math.random().toString(36).slice(2, 8)}`,
  type, pageRole: 'front', fields, source: 'vision', status: 'ready', ...extra
});

// --- string measures --------------------------------------------------------

test('levenshtein: distance and ceiling behave', () => {
  assert.equal(levenshtein('MUHAMMED', 'MUHAMMAD'), 1);
  assert.equal(levenshtein('ASHA', 'ASHA'), 0);
  assert.ok(levenshtein('ABCDEFGH', 'ZZZZ', 2) > 2, 'ceiling short-circuits');
});

test('damerau-levenshtein counts a transposition as one edit', () => {
  assert.equal(damerauLevenshtein('ASHA', 'ASAH'), 1);
  assert.equal(levenshtein('ASHA', 'ASAH'), 2, 'plain levenshtein charges two');
});

test('jaro-winkler rewards a shared prefix', () => {
  assert.ok(jaroWinkler('MUHAMMED', 'MUHAMMAD') > 0.9);
  assert.ok(jaroWinkler('RAJESH', 'ASHA') < 0.7);
  assert.equal(jaroWinkler('SAME', 'SAME'), 1);
});

test('the phonetic key folds transliteration variants together', () => {
  assert.equal(phoneticKey('MUHAMMED'), phoneticKey('MUHAMMAD'));
  assert.notEqual(phoneticKey('RAJESH'), phoneticKey('ASHA'));
});

// --- name comparison --------------------------------------------------------

test('identical names are identical', () => {
  assert.equal(compareNames('ASHA DEVI', 'Asha Devi').verdict, VERDICTS.IDENTICAL);
});

test('word order is a safe variant, not a difference', () => {
  const result = compareNames('MUHAMMED SAKIR K', 'K MUHAMMED SAKIR');
  assert.equal(result.verdict, VERDICTS.SAFE_VARIANT);
  assert.ok(result.signals.includes('token_order'));
});

test('a name run together by the reader is a safe variant', () => {
  const result = compareNames('MUHAMMED SAKIR K', 'MUHAMMEDSAKIR K');
  assert.equal(result.verdict, VERDICTS.SAFE_VARIANT);
  assert.ok(result.signals.includes('spacing_only'));
});

// The real pair from the live cards: lost space AND a transliteration change.
test('lost spacing plus one letter asks for confirmation, never rejects', () => {
  const result = compareNames('MUHAMMEDSAKIR K', 'Muhammad Sakir K');
  assert.equal(result.verdict, VERDICTS.NEEDS_CONFIRMATION);
  assert.notEqual(result.verdict, VERDICTS.DIFFERENT);
});

test('a one-character difference asks for confirmation', () => {
  const result = compareNames('MUHAMMED SAKIR K', 'MUHAMMAD SAKIR K');
  assert.equal(result.verdict, VERDICTS.NEEDS_CONFIRMATION);
});

// The surname-initial relationship: plausible, but inferred, so confirmed.
test('a surname initial is surfaced for confirmation rather than assumed', () => {
  const result = compareNames('MUHAMMED MISHAB SALEEM P', 'MUHAMMED MISHAB SALEEM PARATHODI');
  assert.equal(result.verdict, VERDICTS.NEEDS_CONFIRMATION);
  assert.ok(result.signals.includes('surname_initial'));
  assert.match(result.explanation, /PARATHODI/);
});

test('an abbreviation expansion is a safe variant', () => {
  const result = compareNames('MD SAKIR', 'MUHAMMED SAKIR');
  assert.equal(result.verdict, VERDICTS.SAFE_VARIANT);
  assert.ok(result.signals.includes('abbreviation_expansion'));
});

test('genuinely different names are different', () => {
  assert.equal(compareNames('RAJESH KUMAR', 'ASHA DEVI').verdict, VERDICTS.DIFFERENT);
  assert.equal(compareNames('ANIL SHARMA', 'SUNITA PATEL').verdict, VERDICTS.DIFFERENT);
});

test('a missing name is a confirmation prompt, not a mismatch', () => {
  assert.equal(compareNames('', 'ASHA DEVI').verdict, VERDICTS.NEEDS_CONFIRMATION);
});

// --- diffs ------------------------------------------------------------------

test('diff renders a character-level change', () => {
  assert.equal(renderDiff('MUHAMMED', 'MUHAMMAD'), 'MUHAMM[E→A]D');
  assert.equal(renderNameDiff('MUHAMMED SAKIR K', 'MUHAMMAD SAKIR K'), 'MUHAMM[E→A]D');
});

test('a spacing diff shows the real change, not phantom word swaps', () => {
  const diff = renderNameDiff('MUHAMMEDSAKIR K', 'Muhammad Sakir K');
  assert.equal(diff, 'MUHAMM[E→A]DSAKIRK');
});

// --- the field matrix -------------------------------------------------------

test('a field a document does not carry is never a mismatch', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'ASHA DEVI', dob: '12/08/1997', father_name: 'RAM KUMAR' }),
    document('aadhaar', { holder_name: 'ASHA DEVI', dob: '12-08-1997', gender: 'F', address: '12 MG ROAD, BENGALURU' })
  ]);
  assert.ok(ISSUABLE.has(verdict.decision), `expected an issuable decision, got ${verdict.decision}`);
  assert.deepEqual(verdict.blocking, []);

  const address = verdict.fields.find(field => field.label === 'address');
  assert.deepEqual(address.agreeing, ['aadhaar']);
  assert.ok(address.abstained.some(item => item.type === 'pan'), 'the PAN abstains explicitly');
});

test('gender absent on a PAN does not reject against a gendered Aadhaar', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'ASHA DEVI', dob: '12/08/1997' }),
    document('aadhaar', { holder_name: 'ASHA DEVI', dob: '12/08/1997', gender: 'FEMALE', address: '12 MG ROAD' })
  ]);
  assert.ok(ISSUABLE.has(verdict.decision), `expected an issuable decision, got ${verdict.decision}`);
});

test('M and MALE agree; three date formats agree', () => {
  const verdict = compareDocuments([
    document('aadhaar', { holder_name: 'RAM K', dob: '12/08/1997', gender: 'M', address: 'X' }),
    document('passport', { holder_name: 'RAM K', dob: '1997-08-12', gender: 'MALE' }),
    document('pan', { holder_name: 'RAM K', dob: '12-08-1997' })
  ]);
  assert.ok(ISSUABLE.has(verdict.decision), `expected an issuable decision, got ${verdict.decision}`);
  assert.equal(verdict.fields.find(field => field.label === 'dob').value, '1997-08-12');
  assert.equal(verdict.fields.find(field => field.label === 'gender').value, 'M');
});

test('matrix: document numbers and place of birth are never compared', () => {
  assert.ok(matrix.NEVER_COMPARED.has('document_number'));
  assert.ok(matrix.NEVER_COMPARED.has('place_of_birth'));
  assert.ok(!matrix.COMPARABLE_FIELDS.includes('document_number'));
});

// --- clustering -------------------------------------------------------------

test('clustering: four agree, one dissents, with a usable diff', () => {
  const result = clusterField('holder_name', [
    { type: 'aadhaar', value: 'MUHAMMED SAKIR K', source: 'vision', pageRole: 'front' },
    { type: 'pan', value: 'MUHAMMED SAKIR K', source: 'vision', pageRole: 'front' },
    { type: 'passport', value: 'MUHAMMED SAKIR K', source: 'vision', pageRole: 'front' },
    { type: 'birth_certificate', value: 'MUHAMMED SAKIR K', source: 'vision', pageRole: 'front' },
    { type: 'voter', value: 'MUHAMMAD SAKIR K', source: 'vision', pageRole: 'front' }
  ]);

  assert.equal(result.value, 'MUHAMMED SAKIR K');
  assert.deepEqual(result.agreeing.sort(), ['aadhaar', 'birth_certificate', 'pan', 'passport']);
  assert.equal(result.dissenting.length, 1);
  assert.equal(result.dissenting[0].type, 'voter');
  assert.equal(result.dissenting[0].diff, 'MUHAMM[E→A]D');
  assert.equal(result.dissenting[0].needsConfirmation, true);
});

// Source-quality weighting: a QR-backed value outranks two model guesses.
test('a deterministic source outweighs two vision reads', () => {
  const result = clusterField('holder_name', [
    { type: 'pan', value: 'ASHA DEVL', source: 'vision', pageRole: 'front' },
    { type: 'passport', value: 'ASHA DEVL', source: 'vision', pageRole: 'front' },
    { type: 'aadhaar', value: 'ASHA DEVI', source: 'barcode', pageRole: 'front' }
  ]);
  assert.equal(result.value, 'ASHA DEVI', 'the UIDAI QR reading wins');
  assert.equal(result.evidenceStrong, true);
});

// --- decision policy --------------------------------------------------------

test('a genuinely different person produces a conflict, not a bare rejection', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'ASHA DEVI', dob: '12/08/1997' }),
    document('aadhaar', { holder_name: 'RAJESH KUMAR', dob: '03/11/1985', gender: 'M', address: 'X' })
  ]);
  assert.ok([DECISIONS.DOCUMENT_CONFLICT, DECISIONS.SUSPECTED_CROSS_IDENTITY].includes(verdict.decision));
  assert.equal(verdict.issuable, false);
  assert.equal(verdict.needsManualReview, true);
});

test('a one-character name difference needs confirmation and never blocks outright', () => {
  const verdict = compareDocuments([
    document('aadhaar', { holder_name: 'MUHAMMED SAKIR K', dob: '12/08/1997', gender: 'M', address: 'X' }),
    document('pan', { holder_name: 'MUHAMMED SAKIR K', dob: '12/08/1997' }),
    document('voter', { holder_name: 'MUHAMMAD SAKIR K', dob: '12/08/1997', gender: 'M' })
  ]);
  assert.equal(verdict.decision, DECISIONS.LIKELY_MATCH_NEEDS_CONFIRMATION);
  assert.deepEqual(verdict.blocking, []);
  assert.equal(verdict.issuable, false, 'confirmation is still required before issuing');
});

// A Voter ID prints its address on the BACK, so the comparison only happens
// when that side was actually uploaded.
test('an address difference never blocks', () => {
  const verdict = compareDocuments([
    document('aadhaar', { holder_name: 'RAM K', dob: '01/01/1990', gender: 'M', address: '12 MG ROAD BENGALURU 560001' }),
    document('voter', { holder_name: 'RAM K', dob: '01/01/1990', gender: 'M' }),
    document('voter', { address: '44 BRIGADE ROAD MYSURU 570001' }, { pageRole: 'back' })
  ]);
  assert.ok(ISSUABLE.has(verdict.decision), 'a moved house is not a different person');

  const address = verdict.fields.find(field => field.label === 'address');
  assert.equal(address.severity, 'info');
  assert.equal(address.dissenting.length, 1);
  assert.ok(verdict.notes.includes('address'));
});

test('a voter front abstains from the address comparison entirely', () => {
  const verdict = compareDocuments([
    document('aadhaar', { holder_name: 'RAM K', dob: '01/01/1990', gender: 'M', address: '12 MG ROAD' }),
    document('voter', { holder_name: 'RAM K', dob: '01/01/1990', gender: 'M' })
  ]);
  const address = verdict.fields.find(field => field.label === 'address');
  assert.deepEqual(address.agreeing, ['aadhaar']);
  assert.ok(address.abstained.some(item => item.type === 'voter'));
});

test('a parent-name difference warns but does not block', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'RAM K', dob: '01/01/1990', father_name: 'KRISHNAN NAIR' }),
    document('voter', { holder_name: 'RAM K', dob: '01/01/1990', gender: 'M', father_name: 'KRISHNA NAIR MENON' })
  ]);
  assert.equal(verdict.issuable, true);
  assert.ok(verdict.warnings.includes('guardian_name'));
});

test("a voter's husband name is pooled with a father name, not contradicted", () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'ASHA DEVI', dob: '01/01/1990', father_name: 'RAM KUMAR' }),
    document('voter', { holder_name: 'ASHA DEVI', dob: '01/01/1990', gender: 'F', spouse_name: 'RAM KUMAR' })
  ]);
  assert.ok(ISSUABLE.has(verdict.decision), `expected an issuable decision, got ${verdict.decision}`);
  assert.deepEqual(verdict.blocking, []);
});

test('an unreadable required field is insufficient evidence, not a rejection', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: '', dob: '01/01/1990' }),
    document('aadhaar', { holder_name: '', dob: '01/01/1990', gender: 'M', address: 'X' })
  ]);
  assert.equal(verdict.decision, DECISIONS.INSUFFICIENT_EVIDENCE);
  assert.deepEqual(verdict.blocking, []);
  assert.equal(verdict.needsManualReview, false, 'the holder can fix this themselves');
});

test('one blurry scan does not block a field the others agree on', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'ASHA DEVI', dob: '01/01/1990' }),
    document('aadhaar', { holder_name: 'ASHA DEVI', dob: '', gender: 'F', address: 'X' }),
    document('passport', { holder_name: 'ASHA DEVI', dob: '01/01/1990', gender: 'F' })
  ]);
  assert.ok(ISSUABLE.has(verdict.decision), `expected an issuable decision, got ${verdict.decision}`);
  const dob = verdict.fields.find(field => field.label === 'dob');
  assert.equal(dob.value, '1990-01-01');
  assert.ok(dob.unreadable.some(item => item.type === 'aadhaar'));
});

test('a single document cannot corroborate itself', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'ASHA DEVI', dob: '01/01/1990' })
  ]);
  assert.equal(verdict.decision, DECISIONS.INSUFFICIENT_EVIDENCE);
  assert.equal(verdict.issuable, false);
});

test('the same document passed twice is still one source, not two', () => {
  // Below the API contract too: even if duplicate entries reach the engine,
  // they share a logical id and can never clear the two-document minimum.
  const pan = document('pan', { holder_name: 'ASHA DEVI', dob: '01/01/1990' });
  const verdict = compareDocuments([pan, { ...pan }]);

  const name = verdict.fields.find(field => field.label === 'holder_name');
  assert.equal(name.corroboration, 1, 'duplicate entries count once');
  assert.equal(verdict.decision, DECISIONS.INSUFFICIENT_EVIDENCE);
  assert.equal(verdict.issuable, false);
});

test('two scans of one card are one source; a second card makes two', () => {
  const scanA = document('aadhaar', { holder_name: 'ASHA DEVI', dob: '01/01/1990', gender: 'F' }, { id: 'a-1', logicalId: 'card-a' });
  const scanB = document('aadhaar', { holder_name: 'ASHA DEVI', dob: '01/01/1990' }, { id: 'a-2', logicalId: 'card-a' });

  const alone = compareDocuments([scanA, scanB]);
  assert.equal(alone.decision, DECISIONS.INSUFFICIENT_EVIDENCE, 'pages of one card cannot corroborate each other');

  const withPan = compareDocuments([scanA, scanB, document('pan', { holder_name: 'ASHA DEVI', dob: '01/01/1990' })]);
  assert.ok(ISSUABLE.has(withPan.decision), `expected an issuable decision, got ${withPan.decision}`);
  const name = withPan.fields.find(field => field.label === 'holder_name');
  assert.equal(name.corroboration, 2);
});

test('an integrity failure overrides perfect field agreement', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'ASHA DEVI', dob: '01/01/1990' }),
    document('aadhaar', { holder_name: 'ASHA DEVI', dob: '01/01/1990', gender: 'F', address: 'X' })
  ], { integrity: { ok: false, failures: [{ code: 'foreign_document_reference', detail: 'A document from another application was referenced.' }] } });

  assert.equal(verdict.decision, DECISIONS.BLOCKED_SECURITY_INTEGRITY);
  assert.equal(verdict.issuable, false);
  assert.equal(verdict.needsManualReview, true);
});

test('documents needing a retake ask for one instead of guessing', () => {
  const verdict = compareDocuments([
    document('pan', {}, { status: 'retake_required', statusReason: 'image blurred', fileName: 'pan.jpg' }),
    document('aadhaar', {}, { status: 'retake_required', statusReason: 'glare detected', fileName: 'aadhaar.jpg' })
  ]);
  assert.equal(verdict.decision, DECISIONS.RETAKE_REQUIRED);
  assert.equal(verdict.issuable, false);
});
