// The TypeScript stack profile (v2 ticket 08). Seven fields plus passRules (v2-09) and workspaceSetup (R2 prep); the core knows no stack.
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
  // Shell steps that make a fresh workspace runnable, run by jd_prepare in the worktree.
  // A worktree has no node_modules (gitignored), so the repo's own declared dependencies are installed
  // from its lockfile. This installs what the repo already declares; it never adds tooling.
  workspaceSetup(workPath) {
    const pkg = readPkg(workPath);
    if (!pkg) return [];
    const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
    if (!hasDeps || fs.existsSync(path.join(workPath, 'node_modules'))) return [];
    const has = (f) => fs.existsSync(path.join(workPath, f));
    const command = has('pnpm-lock.yaml') ? 'pnpm install --frozen-lockfile'
      : has('yarn.lock') ? 'yarn install --frozen-lockfile'
      : has('bun.lock') || has('bun.lockb') ? 'bun install --frozen-lockfile'
      : has('package-lock.json') || has('npm-shrinkwrap.json') ? 'npm ci'
      : 'npm install --no-package-lock'; // no lockfile: install without writing one into the branch
    return [{ id: 'deps', what: `install the repo's declared dependencies (${command})`, command }];
  },
  // Pass rules for tool-call checks: name -> (toolResult) => ({ok, output}). TS defines none (its checks are shell).
  passRules: {},
  // Worker tools to hide. TS: none.
  hiddenTools: [],
  // How to capture evidence for human checks. TS: none.
  humanEvidence: null,
  // Per-profile limits, in ms.
  timeouts: { checkMs: 10 * 60 * 1000 },
};
