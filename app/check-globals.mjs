// Catches identifiers that exist as browser globals but not in Hermes.
//
// `event.id` shipped a crash to TestFlight: on web it silently resolved to the
// legacy `window.event`, so every web build passed and the bug only appeared on
// a phone. These names are the ones that fail that way.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RISKY = ['event', 'name', 'status', 'location', 'history', 'screen', 'top', 'parent',
               'origin', 'length', 'closed', 'frames', 'self'];

const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js') && !p.endsWith('.test.mjs')) files.push(p);
  }
})('app');
walk: for (const d of ['src']) {
  for (const f of readdirSync(d)) {
    if (f.endsWith('.js') && !f.includes('.test.')) files.push(join(d, f));
  }
}

const problems = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const declared = new Set();
  for (const m of src.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  // Destructuring, params and imports all count as declarations.
  for (const m of src.matchAll(/[({,[]\s*([A-Za-z_$][\w$]*)\s*[,)}\]:=]/g)) declared.add(m[1]);
  for (const m of src.matchAll(/import\s+{([^}]*)}/g)) {
    for (const n of m[1].split(',')) declared.add(n.trim().split(/\s+as\s+/).pop());
  }
  for (const name of RISKY) {
    if (declared.has(name)) continue;
    // Property access only: `event.id` or `event[k]`. A sentence period is
    // followed by a space, so prose like "keeps every event. Deleting..." is
    // not a match.
    const re = new RegExp(`(?<![.\\w$'"\`])${name}(?:\\.[A-Za-z_$]|\\[)`, 'g');
    for (const m of src.matchAll(re)) {
      const line = src.slice(0, m.index).split('\n').length;
      problems.push(`${file}:${line}  '${name}' is used but never declared here`);
    }
  }
}

// The checker has its own check: a regex that stops catching the bug it was
// written for is worse than no checker.
const probe = (src, name) => {
  const re = new RegExp(`(?<![.\\w$'"\`])${name}(?:\\.[A-Za-z_$]|\\[)`, 'g');
  return [...src.matchAll(re)].length;
};
if (probe('await Events.update(event.id, {})', 'event') !== 1) throw new Error('self-test: missed a real access');
if (probe('Archiving keeps every event. Deleting is not allowed', 'event') !== 0) throw new Error('self-test: matched prose');
if (probe('const e = list[0]; e.event.id', 'event') !== 0) throw new Error('self-test: matched a property');
if (probe('handler(event, picked)', 'event') !== 0) throw new Error('self-test: matched a bare argument');

if (problems.length) {
  console.error('Undeclared browser-global identifiers (these crash on Hermes):');
  problems.forEach((p) => console.error('  ' + p));
  process.exit(1);
}
console.log(`OK  no undeclared browser globals (${files.length} files)`);
