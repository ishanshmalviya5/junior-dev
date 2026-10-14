// The TypeScript stack profile (v2 ticket 08). Exactly seven fields; the core knows no stack.
// Shapes are kept open for tool-call checks (ticket 09 adds a `tool` check kind beside `shell`).
import fs from 'node:fs';
import path from 'node:path';

const readPkg = (repo) => {
  try { return JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')); } catch { return null; }
};

export default {
  name: 'ts',
  // How to recognise a repo: every listed file must exist at its root.
  markers: { all: ['package.json', 'tsconfig.json'] },
  // What preflight must confirm beyond the plan's own commands. TS: nothing beyond node/npm being present.
  readiness: [],
  // Suggestions for the verification plan, from the repo's own scripts. Never installs tooling.
  // Each check passes on exit 0 (the shell pass rule).
  defaultChecks(repo) {
    const pkg = readPkg(repo);
    if (!pkg) return [];
    const scripts = pkg.scripts ?? {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const out = [];
    if (scripts.test) out.push({ id: 'test', kind: 'shell', command: 'npm test', pass: 'exit0' });
    if (scripts.typecheck) out.push({ id: 'typecheck', kind: 'shell', command: 'npm run typecheck', pass: 'exit0' });
    else if (deps.typescript) out.push({ id: 'typecheck', kind: 'shell', command: 'npx --no-install tsc --noEmit', pass: 'exit0' });
    if (scripts.lint) out.push({ id: 'lint', kind: 'shell', command: 'npm run lint', pass: 'exit0' });
    return out;
  },
  // Stack text for worker briefs. Adapted from the tdd and codebase-design skills (see CREDITS.md).
  guidance: [
    'TypeScript repo notes:',
    '- Put types at module seams: exported functions and public interfaces get explicit types; let inference work inside.',
    '- Test through public interfaces, not internals; a refactor should not break a test.',
    '- Mock only at boundaries (network, disk, clock); never mock your own modules.',
    '- Change tooling (hooks, formatters, test helper libraries) only when a requirement calls for it.',
  ].join('\n'),
  // Worker tools to hide. TS: none.
  hiddenTools: [],
  // How to capture evidence for human checks. TS: none.
  humanEvidence: null,
  // Per-profile limits, in ms.
  timeouts: { checkMs: 10 * 60 * 1000 },
};
