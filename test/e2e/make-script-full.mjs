// Writes script-full.json: a whole junior-dev run in real DSH with the fake model.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const toy = path.join(os.homedir(), '.dsh-test/work/toy');
const m = { provider: '$PROVIDER', model: '$MODEL' };
const hl = (x) => `## Highlights\n### What gets built\n- ${x}\n### What doesn't\n- i18n\n### Decisions & assumptions\n- none\n### What needs you\n- nothing\n`;
const reqs = `# Greet — Requirements\n${hl('greet')}## Requirements\n- **A1 Greet.** greet(name) returns "Hello, <name>!".\n- **B1 Export.** index.js exports greet.\n`;
const greetCheck = `node -e "import('./greet.js').then(m=>process.exit(m.greet('Bo')==='Hello, Bo!'?0:1))"`;
const exportCheck = `node -e "import('./index.js').then(m=>process.exit(typeof m.greet==='function'?0:1))"`;
const vp = `# VP\n${hl('checks')}## Checks\n| ID | Kind | Check | Proves | Command |\n|---|---|---|---|---|\n| U1 | automated | greet works | A1 | \`${greetCheck}\` |\n| U2 | automated | export works | B1 | \`${exportCheck}\` |\n`;
const tool = (t, args = {}) => ({ tool: t, args });
const root = [
  tool('jd_status'), tool('jd_start'), tool('jd_fact', { text: 'toy repo is ESM', source: 'package.json' }), tool('jd_advance', { to: 'interview' }),
  tool('jd_ask', { question: 'Should greet() trim the name?', header: 'Trim', options: ['No', 'Yes'], recommended: 'No' }),
  tool('jd_set', { key: 'repos', value: [{ path: toy, mode: 'worktree' }] }),
  tool('jd_set', { key: 'permissions', value: { push: false, pr: false, remoteWrites: [], debugEnv: null } }),
  tool('jd_set', { key: 'budget', value: { timeMin: 30, tokens: 5000000 } }),
  tool('jd_set', { key: 'models', value: { planner: m, builder: m, checker: m } }),
  tool('jd_set', { key: 'crossModel', value: { enabled: false } }),
  tool('jd_set', { key: 'dial', value: 'balanced' }),
  tool('jd_advance', { to: 'prd_parity' }), tool('jd_parity', { key: 'prd', restatement: 'Add greet(name) and export it.' }),
  tool('jd_advance', { to: 'requirements' }), tool('jd_write_doc', { key: 'requirements', content: reqs }), tool('jd_parity', { key: 'requirements', restatement: 'A1 greet, B1 export.' }),
  tool('jd_advance', { to: 'verification_plan' }), tool('jd_write_doc', { key: 'verificationPlan', content: vp }), tool('jd_parity', { key: 'verificationPlan', restatement: 'U1 and U2, both automated.' }),
  tool('jd_advance', { to: 'specs' }), tool('jd_write_doc', { key: 'specs', content: '# Specs\n- **S1 greet.** greet.js exports greet [A1]\n- **S2 export.** index.js re-exports greet [B1]\n' }),
  tool('jd_advance', { to: 'implementation_plan' }), tool('jd_write_doc', { key: 'implementationPlan', content: '# Plan\n| Step | Work | Specs | Checks |\n|---|---|---|---|\n| P1 | greet | S1 | U1 |\n| P2 | export | S2 | U2 |\n' }),
  tool('jd_tree', { op: 'init' }),
  tool('jd_tree', { op: 'split', nodeId: 'N', children: [
    { title: 'greet()', doneWhen: ['greet returns the greeting'], covers: ['N#A1'], traces: { requirements: ['A1'] }, checks: [{ command: greetCheck, cwd: toy }], provides: [{ name: 'greet', description: 'greet(name): string' }] },
    { title: 'export', doneWhen: ['index.js exports greet'], covers: ['N#B1'], traces: { requirements: ['B1'] }, checks: [{ command: exportCheck, cwd: toy }], dependsOn: ['#1'], uses: ['C:N.1:greet'] },
  ] }),
  tool('jd_advance', { to: 'preflight' }), tool('jd_preflight', { items: [{ what: 'node runs', command: 'node --version' }] }),
  tool('jd_advance', { to: 'final_parity' }), tool('jd_prepare'), tool('jd_parity', { key: 'final', restatement: 'Build greet + export in a worktree, no push.' }),
  tool('jd_run'), { text: 'The build loop started; you can step away.' }, { text: 'REPORT RELAYED' },
];
const workers = [
  { match: '^You are a junior-dev builder[\\s\\S]*Your item: N\\.1 ', steps: [tool('bash', { command: "cd $WORKDIR && printf 'export const greet = (n) => `Hello, ${n}!`;\\n' > greet.js && cat greet.js" }), tool('jd_submit', { summary: 'greet.js added' }), { text: 'done' }] },
  { match: '^You are a junior-dev builder[\\s\\S]*Your item: N\\.2 ', steps: [tool('bash', { command: "cd $WORKDIR && printf \"export { greet } from './greet.js';\\n\" > index.js" }), tool('bash', { command: 'git push origin HEAD' }), tool('jd_submit', { summary: 'export added' }), { text: 'done' }] },
];
fs.writeFileSync(new URL('./script-full.json', import.meta.url), JSON.stringify({ root, workers }, null, 2));
console.log(`script-full.json: ${root.length} root steps, ${workers.length} worker scripts`);
