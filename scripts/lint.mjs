// Syntax-check every JS module (no external linter dependency).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['lib', 'test', 'scripts', 'client'];
const files = [];
const walk = (d) => {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory() && e.name !== 'node_modules') walk(p);
    else if (/\.(m?js)$/.test(e.name)) files.push(p);
  }
};
roots.forEach(walk);
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    console.error(`✖ ${f}\n${e.stderr}`);
  }
}
console.log(`lint: ${files.length} files, ${bad} with errors`);
process.exit(bad ? 1 : 0);
