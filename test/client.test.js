// The progress dock (client/client.js), rendered with a stub React: no browser needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PHASES } from '../lib/engine/phases.js';

const SRC = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

/** Load the client and return render(data, open) → element tree. */
function loadDock() {
  let mod;
  let Dock;
  let states = [];
  const React = {
    createElement: (type, props, ...children) => (typeof type === 'function' ? type({ ...props, children }) : { type, props: props ?? {}, children: children.flat() }),
    useState: (init) => [states.length ? states.shift() : init, () => {}],
    useEffect: () => {},
  };
  vm.runInNewContext(SRC, { window: { __ModuleLoader__: { load: (m) => (mod = m) }, location: { pathname: '/s/abcdefabcdefabcdef' } } });
  const plugin = mod.factory((name) => (name === 'react' ? React : null));
  plugin.apply({ slots: { inject: (_n, fn) => fn(), register: (_o, C) => (Dock = C) } });
  return (data, open = false) => {
    states = [data, open];
    return Dock({ sessionId: 'S1' });
  };
}

const walk = (n, out = []) => {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children ?? []) walk(c, out);
  }
  return out;
};
const byTestId = (tree, id) => walk(tree).find((n) => n.props?.['data-testid'] === id);
const text = (n) => walk(n).flatMap((x) => x.children.filter((c) => typeof c === 'string' || typeof c === 'number')).join(' ');
const base = { active: true, feature: 'discount-codes', side: null, loopRunning: false, checklist: [], bar: { done: 0, total: 0, pct: 0 }, queued: 0 };

test('v2-13: the dock\'s phase list matches the engine\'s', () => {
  const m = SRC.match(/const PHASES = (\[[^\]]+\]);/);
  assert.ok(m, 'PHASES literal in client.js');
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), [...PHASES]);
});

test('v2-13: the dock bar moves through the whole run (planning phases, leaves, verify, deliver), never backwards', () => {
  const render = loadDock();
  const pctAt = (phase, bar) => byTestId(render({ ...base, phase, bar: bar ?? base.bar }), 'junior-dev-bar').props['aria-valuenow'];
  const seq = [
    ...PHASES.slice(0, PHASES.indexOf('build')).map((p) => pctAt(p)),
    pctAt('build', { done: 0, total: 4 }), pctAt('build', { done: 2, total: 4 }), pctAt('build', { done: 4, total: 4 }),
    pctAt('verify'), pctAt('human_checks'), pctAt('deliver'), pctAt('done'),
  ];
  assert.equal(seq[0], 0);
  assert.equal(seq.at(-1), 100);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1], `step ${i}: ${seq.join(',')}`);
  assert.ok(pctAt('requirements') > 0, 'planning already moves the bar');
  assert.ok(pctAt('build', { done: 2, total: 4 }) > pctAt('build', { done: 0, total: 4 }), 'leaves move the bar');
});

test('v2-13: the dock matches the composer width and shows stage, label, percent; side states and notes are shown', () => {
  const render = loadDock();
  const dock = render({ ...base, phase: 'requirements' });
  assert.match(dock.props.style.maxWidth, /--dsh-composer-card-max-width/);
  assert.match(dock.props.style.width, /--dsh-composer-side-clearance/);
  assert.match(text(dock), /Junior Dev discount-codes · Requirements \d+%/);
  assert.equal(byTestId(dock, 'junior-dev-checklist'), undefined, 'no tree yet, no checklist');

  const items = [{ id: 'N.1', title: 'applyDiscount', status: 'done', done: 2, total: 2 }, { id: 'N.2', title: 'glossary', status: 'working', done: 0, total: 1 }];
  const building = render({ ...base, phase: 'build', loopRunning: true, checklist: items, bar: { done: 2, total: 3, pct: 67 }, parked: 1, queued: 2 }, true);
  assert.match(text(building), /Build · 2 of 3 done/);
  assert.match(text(byTestId(building, 'junior-dev-checklist')), /applyDiscount 2\/2.*glossary 0\/1/);
  assert.match(text(byTestId(building, 'junior-dev-notes')), /1 waiting on your answers · 2 questions queued/);

  const blocked = render({ ...base, phase: 'build', side: 'blocked', sideReason: 'budget reached', bar: { done: 1, total: 3 } });
  assert.match(text(byTestId(blocked, 'junior-dev-notes')), /blocked: budget reached/);
  assert.equal(render({ active: false }), null);
});
