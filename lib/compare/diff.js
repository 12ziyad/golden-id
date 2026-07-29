'use strict';

const { tokenSetDistance } = require('./levenshtein');

// Character-level diffs rendered for a human reading a rejection notice:
//   MUHAMM[E→A]D SAKIR K
// The holder can see at a glance that one card says E and another says A, which
// is the difference between an OCR slip and a genuinely different person.

const ARROW = '→'; // →

/** Full edit script between two strings: equal / replace / insert / delete. */
function editScript(a, b) {
  const left = String(a == null ? '' : a);
  const right = String(b == null ? '' : b);
  const rows = left.length;
  const columns = right.length;

  const table = Array.from({ length: rows + 1 }, () => new Array(columns + 1).fill(0));
  for (let i = 0; i <= rows; i++) table[i][0] = i;
  for (let j = 0; j <= columns; j++) table[0][j] = j;
  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= columns; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + cost);
    }
  }

  const operations = [];
  let i = rows;
  let j = columns;
  while (i > 0 || j > 0) {
    const cost = i > 0 && j > 0 && left[i - 1] === right[j - 1] ? 0 : 1;
    if (i > 0 && j > 0 && table[i][j] === table[i - 1][j - 1] + cost) {
      operations.push(cost === 0
        ? { type: 'equal', left: left[i - 1], right: right[j - 1] }
        : { type: 'replace', left: left[i - 1], right: right[j - 1] });
      i--; j--;
    } else if (i > 0 && table[i][j] === table[i - 1][j] + 1) {
      operations.push({ type: 'delete', left: left[i - 1], right: '' });
      i--;
    } else {
      operations.push({ type: 'insert', left: '', right: right[j - 1] });
      j--;
    }
  }
  return operations.reverse();
}

/**
 * Render the difference between two strings as `MUHAMM[E→A]D`.
 * Deletions render as `[X→]`, insertions as `[→X]`.
 */
function renderDiff(a, b) {
  const operations = editScript(a, b);
  let output = '';
  let pendingLeft = '';
  let pendingRight = '';

  const flush = () => {
    if (!pendingLeft && !pendingRight) return;
    output += `[${pendingLeft}${ARROW}${pendingRight}]`;
    pendingLeft = '';
    pendingRight = '';
  };

  for (const operation of operations) {
    if (operation.type === 'equal') {
      flush();
      output += operation.left;
    } else {
      // Collect a run of adjacent changes into one bracket.
      pendingLeft += operation.left;
      pendingRight += operation.right;
    }
  }
  flush();
  return output;
}

/**
 * Diff two names without letting word order create noise. Tokens are paired by
 * best match first, so "K MUHAMMAD SAKIR" against "MUHAMMED SAKIR K" reports
 * only the letter that actually differs.
 */
function renderNameDiff(a, b) {
  const comparison = tokenSetDistance(a, b);
  if (comparison.sameTokens) return '';

  // When the two readings differ mainly by where the spaces fell, the
  // token-by-token walk produces a misleading pile of phantom word changes.
  // Diff the run-together forms instead, which shows the real difference.
  if (comparison.spacing) {
    const glue = value => String(value || '').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
    return renderDiff(glue(a), glue(b));
  }

  const parts = [];
  for (const pair of comparison.pairs) {
    if (pair.distance > 0) parts.push(renderDiff(pair.left, pair.right));
  }
  for (const item of comparison.unmatched) {
    parts.push(item.side === 'left' ? `[${item.token}${ARROW}]` : `[${ARROW}${item.token}]`);
  }
  return parts.join(' ') || renderDiff(a, b);
}

/** Pick the right diff renderer for a field. */
function diffFor(field, a, b) {
  const isName = /name$/.test(field) || field === 'guardian_name';
  return isName ? renderNameDiff(a, b) : renderDiff(a, b);
}

module.exports = { editScript, renderDiff, renderNameDiff, diffFor, ARROW };
