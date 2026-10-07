import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function tmpdir(prefix = 'jd-') {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

export function gitRepo(dir, files = { 'README.md': '# toy\n' }) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  g('config', 'commit.gpgsign', 'false');
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return g;
}

export const PRD = `# Add a greeting helper\n\nWe need a greet(name) function that returns "Hello, <name>!".\n`;

export const REQUIREMENTS = `# Requirements

## Highlights
### What gets built
- greet()
### What doesn't
- i18n
### Decisions & assumptions
| # | Decision | Source |
|---|---|---|
| D1 | ESM | research |
### What needs you
- nothing

## Requirements
- **A1 Greet.** greet(name) returns "Hello, <name>!".
- **A2 Empty.** greet("") returns "Hello!".
- **B1 Export.** greet is exported from index.js.
`;

export const VP = `# Verification plan

## Highlights
### What gets built
- tests
### What doesn't
- none
### Decisions & assumptions
- none
### What needs you
- H1

## Checks
| ID | Kind | Check | Proves | Command |
|---|---|---|---|---|
| U1 | automated | unit test greet | A1, A2 | \`node --test\` |
| U2 | automated | export test | B1 | |
| H1 | human | read the output | A1 | |
`;

export const SPECS = `# Specs
- **S1 greet.** Implement greet in greet.js [A1, A2]
- **S2 export.** Re-export from index.js [B1]
`;

export const PLAN = `# Plan
| Step | Work | Specs | Checks |
|---|---|---|---|
| P1 | write greet | S1 | U1 |
| P2 | export | S2 | U2 |

| Check | Command | Cwd |
|---|---|---|
| U2 | \`node -e "import('./index.js')"\` | |
`;
