'use strict';

// Calibrate the face threshold against REAL document photographs.
//
// The unit tests use synthetic vectors: they prove the cosine maths, and
// nothing whatsoever about whether a real passport photo matches a real voter
// card photo. The default threshold of 0.5 is an explicit guess. Until this
// benchmark has been run over labelled pairs, the face score is advisory noise
// and must not be treated as evidence of identity.
//
// Usage:
//   node scripts/face-benchmark.js <directory>
//
// Layout: one sub-directory per person, each containing that person's document
// photographs. Pairs within a directory are genuine; pairs across directories
// are impostors.
//
//   samples/
//     person-a/  pan.jpg  aadhaar.jpg  passport.jpg
//     person-b/  pan.jpg  voter.jpg
//
// Reports FAR/FRR across a sweep of thresholds and the equal-error point.

const fs = require('fs');
const path = require('path');
const { embedDocument } = require('../lib/face/embed');
const { cosineSimilarity } = require('../lib/face/match');

const IMAGE = /\.(jpe?g|png)$/i;

async function collect(root) {
  const people = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const files = fs.readdirSync(directory).filter(name => IMAGE.test(name));
    if (!files.length) continue;

    const faces = [];
    for (const file of files) {
      process.stdout.write(`  reading ${entry.name}/${file} … `);
      try {
        const result = await embedDocument(fs.readFileSync(path.join(directory, file)));
        if (result.face) {
          faces.push({ file, embedding: result.face.embedding, confidence: result.face.confidence, rotation: result.face.rotation });
          console.log(`face found (confidence ${result.face.confidence}, rotation ${result.face.rotation}°)`);
        } else {
          console.log(`no usable face (${result.reason})`);
        }
      } catch (error) {
        console.log(`failed: ${error.message}`);
      }
    }
    if (faces.length) people.push({ name: entry.name, faces });
  }
  return people;
}

function pairs(people) {
  const genuine = [];
  const impostor = [];

  for (let i = 0; i < people.length; i++) {
    const person = people[i];
    for (let a = 0; a < person.faces.length; a++) {
      for (let b = a + 1; b < person.faces.length; b++) {
        const score = cosineSimilarity(person.faces[a].embedding, person.faces[b].embedding);
        if (score != null) genuine.push({ score, label: `${person.name}: ${person.faces[a].file} ↔ ${person.faces[b].file}` });
      }
    }
    for (let j = i + 1; j < people.length; j++) {
      for (const left of person.faces) {
        for (const right of people[j].faces) {
          const score = cosineSimilarity(left.embedding, right.embedding);
          if (score != null) impostor.push({ score, label: `${person.name}/${left.file} ↔ ${people[j].name}/${right.file}` });
        }
      }
    }
  }
  return { genuine, impostor };
}

function sweep(genuine, impostor) {
  const rows = [];
  for (let threshold = 0.20; threshold <= 0.95; threshold += 0.05) {
    // False reject: a genuine pair scoring below the threshold.
    const frr = genuine.length ? genuine.filter(pair => pair.score < threshold).length / genuine.length : null;
    // False accept: an impostor pair scoring at or above it.
    const far = impostor.length ? impostor.filter(pair => pair.score >= threshold).length / impostor.length : null;
    rows.push({ threshold: Number(threshold.toFixed(2)), far, frr });
  }
  return rows;
}

async function main() {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: node scripts/face-benchmark.js <directory-of-person-folders>');
    console.error('Each sub-directory is one person; images inside it are their documents.');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(root)) {
    console.error(`No such directory: ${root}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Reading document photographs from ${root}\n`);
  const people = await collect(root);

  if (people.length < 1) {
    console.error('\nNo faces were detected in any sample. Nothing can be calibrated.');
    process.exitCode = 1;
    return;
  }

  const { genuine, impostor } = pairs(people);
  console.log(`\n${people.length} people, ${genuine.length} genuine pair(s), ${impostor.length} impostor pair(s)\n`);

  if (!genuine.length) {
    console.error('No genuine pairs: each person needs at least two documents carrying a photograph.');
    process.exitCode = 1;
    return;
  }

  console.log('Genuine pairs (same person):');
  for (const pair of genuine.sort((a, b) => a.score - b.score)) console.log(`  ${pair.score.toFixed(4)}  ${pair.label}`);
  if (impostor.length) {
    console.log('\nImpostor pairs (different people):');
    for (const pair of impostor.sort((a, b) => b.score - a.score).slice(0, 20)) console.log(`  ${pair.score.toFixed(4)}  ${pair.label}`);
  }

  console.log('\nThreshold sweep:');
  console.log('  thresh    FAR      FRR');
  const rows = sweep(genuine, impostor);
  for (const row of rows) {
    console.log(`  ${row.threshold.toFixed(2)}      ${row.far == null ? '  —  ' : row.far.toFixed(3)}    ${row.frr == null ? '  —  ' : row.frr.toFixed(3)}`);
  }

  const usable = rows.filter(row => row.far != null && row.frr != null);
  if (usable.length) {
    const eer = usable.reduce((best, row) => (Math.abs(row.far - row.frr) < Math.abs(best.far - best.frr) ? row : best));
    console.log(`\nEqual-error point ≈ threshold ${eer.threshold} (FAR ${eer.far.toFixed(3)}, FRR ${eer.frr.toFixed(3)})`);
    console.log(`Set FACE_MATCH_THRESHOLD accordingly — and note that with ${genuine.length} genuine and ${impostor.length} impostor pairs`);
    console.log('this is an indication, not a calibration. A defensible threshold needs hundreds of pairs.');
  } else {
    const lowest = Math.min(...genuine.map(pair => pair.score));
    console.log(`\nNo impostor pairs, so a false-accept rate cannot be measured. Lowest genuine score: ${lowest.toFixed(4)}.`);
    console.log('Add a second person before drawing any conclusion about the threshold.');
  }

  console.log('\nFace matching remains ADVISORY. It never blocks a Golden ID.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
