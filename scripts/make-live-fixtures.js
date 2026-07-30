'use strict';

// Render synthetic Indian-ID-style cards for LIVE testing, into a directory
// OUTSIDE the repository. Entirely fictional people; the Aadhaar-style number
// is Verhoeff-valid so the checksum path runs, and every card carries the
// labels the OCR field patterns expect.
//
//   node scripts/make-live-fixtures.js <output-dir>

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { verhoeffDigit } = require('../lib/validate/checksums');

const outDir = process.argv[2];
if (!outDir) { console.error('Usage: node scripts/make-live-fixtures.js <output-dir>'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function panCard({ name, father, dob, number }) {
  return `<svg width="1000" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1000" height="630" fill="#f6f2e7"/>
  <rect width="1000" height="90" fill="#2b5e9c"/>
  <text x="50" y="58" font-family="Arial" font-size="34" fill="#fff">INCOME TAX DEPARTMENT   GOVT. OF INDIA</text>
  <text x="50" y="150" font-family="Arial" font-size="26" fill="#444">Permanent Account Number Card</text>
  <text x="50" y="215" font-family="Arial" font-size="24" fill="#444">Permanent Account Number</text>
  <text x="50" y="258" font-family="Arial" font-size="34" font-weight="bold" fill="#111">${esc(number)}</text>
  <text x="50" y="330" font-family="Arial" font-size="24" fill="#444">Name</text>
  <text x="50" y="373" font-family="Arial" font-size="32" font-weight="bold" fill="#111">${esc(name)}</text>
  <text x="50" y="440" font-family="Arial" font-size="24" fill="#444">Father's Name</text>
  <text x="50" y="483" font-family="Arial" font-size="30" font-weight="bold" fill="#111">${esc(father)}</text>
  <text x="50" y="550" font-family="Arial" font-size="24" fill="#444">Date of Birth</text>
  <text x="50" y="592" font-family="Arial" font-size="30" font-weight="bold" fill="#111">${esc(dob)}</text>
  <text x="640" y="600" font-family="Arial" font-size="16" fill="#999">SYNTHETIC TEST CARD — NOT A REAL DOCUMENT</text>
</svg>`;
}

function aadhaarCard({ name, dob, gender, number, address }) {
  return `<svg width="1000" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1000" height="630" fill="#f0e9d8"/>
  <rect width="1000" height="80" fill="#e0ecd8"/>
  <text x="50" y="52" font-family="Arial" font-size="28" fill="#c96">भारत सरकार  GOVERNMENT OF INDIA</text>
  <text x="50" y="180" font-family="Arial" font-size="34" font-weight="bold" fill="#111">${esc(name)}</text>
  <text x="50" y="240" font-family="Arial" font-size="28" fill="#333">DOB: ${esc(dob)}</text>
  <text x="50" y="295" font-family="Arial" font-size="28" fill="#333">${esc(gender)}</text>
  <text x="50" y="370" font-family="Arial" font-size="24" fill="#444">Address: ${esc(address)}</text>
  <text x="200" y="520" font-family="Arial" font-size="44" font-weight="bold" letter-spacing="6" fill="#111">${esc(number)}</text>
  <rect x="0" y="560" width="1000" height="18" fill="#d33"/>
  <text x="620" y="605" font-family="Arial" font-size="16" fill="#999">SYNTHETIC TEST CARD — NOT A REAL DOCUMENT</text>
</svg>`;
}

function voterCard({ name, father, number }) {
  return `<svg width="1000" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1000" height="630" fill="#f2f5fa"/>
  <rect width="1000" height="90" fill="#20406e"/>
  <text x="50" y="58" font-family="Arial" font-size="30" fill="#fff">ELECTION COMMISSION OF INDIA</text>
  <text x="50" y="150" font-family="Arial" font-size="26" fill="#444">Elector Photo Identity Card</text>
  <text x="50" y="230" font-family="Arial" font-size="30" font-weight="bold" fill="#111">${esc(number)}</text>
  <text x="50" y="320" font-family="Arial" font-size="24" fill="#444">Elector's Name</text>
  <text x="50" y="363" font-family="Arial" font-size="32" font-weight="bold" fill="#111">${esc(name)}</text>
  <text x="50" y="440" font-family="Arial" font-size="24" fill="#444">Father's Name</text>
  <text x="50" y="483" font-family="Arial" font-size="30" font-weight="bold" fill="#111">${esc(father)}</text>
  <text x="640" y="600" font-family="Arial" font-size="16" fill="#999">SYNTHETIC TEST CARD — NOT A REAL DOCUMENT</text>
</svg>`;
}

const aadhaarNumber = body => `${body}${verhoeffDigit(body)}`;
const spaced = number => number.replace(/(\d{4})(?=\d)/g, '$1 ');

(async () => {
  const { assessQuality } = require('../lib/preprocess');

  const render = svg => sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  const write = (name, buffer) => {
    fs.writeFileSync(path.join(outDir, name), buffer);
    console.log(`wrote ${name} (${buffer.length} bytes)`);
  };

  // Person 1: ASHA TESTPERSON — the clean happy path + removal/dup tests.
  const ashaAadhaar = aadhaarNumber('23412341234');
  write('pan-asha.jpg', await render(panCard({
    name: 'ASHA TESTPERSON', father: 'RAMESH TESTPERSON', dob: '01/01/1990', number: 'BQIPS8241E'
  })));
  write('aadhaar-asha.jpg', await render(aadhaarCard({
    name: 'ASHA TESTPERSON', dob: '01/01/1990', gender: 'FEMALE',
    number: spaced(ashaAadhaar), address: '12 MG ROAD, BENGALURU 560001'
  })));
  write('voter-asha.jpg', await render(voterCard({
    name: 'ASHA TESTPERSON', father: 'RAMESH TESTPERSON', number: 'ABC1234567'
  })));

  // Person 2: soft transliteration pair for the confirmation flow.
  write('pan-sakir.jpg', await render(panCard({
    name: 'MUHAMMED SAKIR K', father: 'ABDUL RAHMAN K', dob: '12/08/1997', number: 'HZVPK5578Q'
  })));
  write('aadhaar-sakir.jpg', await render(aadhaarCard({
    name: 'MUHAMMAD SAKIR K', dob: '12/08/1997', gender: 'MALE',
    number: spaced(aadhaarNumber('32043976787')), address: '4 BEACH ROAD, KOZHIKODE 673001'
  })));

  // Person 1 with a CONFLICTING DOB — must block, with no confirm path.
  write('aadhaar-asha-wrongdob.jpg', await render(aadhaarCard({
    name: 'ASHA TESTPERSON', dob: '05/05/1970', gender: 'FEMALE',
    number: spaced(aadhaarNumber('98765432109')), address: '12 MG ROAD, BENGALURU 560001'
  })));

  // Person 3: VIKRAM RECOVERY — blur-recovery demonstration.
  const vikramClean = await render(panCard({
    name: 'VIKRAM RECOVERY', father: 'MOHAN RECOVERY', dob: '15/06/1985', number: 'CQIPS7311F'
  }));
  write('pan-vikram.jpg', vikramClean);
  const vikramAadhaarClean = await render(aadhaarCard({
    name: 'VIKRAM RECOVERY', dob: '15/06/1985', gender: 'MALE',
    number: spaced(aadhaarNumber('45678912345')), address: '9 LAKE VIEW, MYSURU 570001'
  }));

  // Find a blur that genuinely lands in each tier at this resolution.
  let marginal = null;
  for (let blur = 1.4; blur <= 6; blur += 0.2) {
    const rounded = Number(blur.toFixed(1));
    const candidate = await sharp(vikramAadhaarClean).blur(rounded).jpeg({ quality: 85 }).toBuffer();
    const quality = await assessQuality(candidate);
    console.log(`  probe blur=${rounded} tier=${quality.tier} sharpness=${quality.metrics.sharpness}`);
    if (quality.tier === 'marginal') { marginal = { blur: rounded, buffer: candidate }; break; }
    if (quality.tier === 'unusable') break;
  }
  if (!marginal) throw new Error('could not produce a marginal-tier blur — thresholds moved?');
  write(`aadhaar-vikram-blur${marginal.blur}.jpg`, marginal.buffer);
  console.log(`  marginal tier confirmed at blur=${marginal.blur}`);

  const hopeless = await sharp(vikramAadhaarClean).blur(8).jpeg({ quality: 80 }).toBuffer();
  const hopelessQuality = await assessQuality(hopeless);
  if (hopelessQuality.tier !== 'unusable') throw new Error(`blur 8 measured ${hopelessQuality.tier}, expected unusable`);
  write('aadhaar-vikram-blur8.jpg', hopeless);
  console.log('  unusable tier confirmed at blur=8');

  // Person 4: NEHA FORMFILL — no DOB on either card, for the manual-entry flow.
  write('pan-neha.jpg', await render(`<svg width="1000" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1000" height="630" fill="#f6f2e7"/>
  <rect width="1000" height="90" fill="#2b5e9c"/>
  <text x="50" y="58" font-family="Arial" font-size="34" fill="#fff">INCOME TAX DEPARTMENT   GOVT. OF INDIA</text>
  <text x="50" y="150" font-family="Arial" font-size="26" fill="#444">Permanent Account Number Card</text>
  <text x="50" y="240" font-family="Arial" font-size="34" font-weight="bold" fill="#111">DQIPS5521G</text>
  <text x="50" y="330" font-family="Arial" font-size="24" fill="#444">Name</text>
  <text x="50" y="373" font-family="Arial" font-size="32" font-weight="bold" fill="#111">NEHA FORMFILL</text>
  <text x="640" y="600" font-family="Arial" font-size="16" fill="#999">SYNTHETIC TEST CARD — NOT A REAL DOCUMENT</text>
</svg>`));
  write('voter-neha.jpg', await render(voterCard({
    name: 'NEHA FORMFILL', father: 'SUNIL FORMFILL', number: 'XYZ7654321'
  })));

  console.log('done.');
})();
