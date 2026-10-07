// Parsers and traceability validators for the document chain (S3 guards, D2–D4).
// The writer instructions (host) produce documents in exactly these shapes.

export const HIGHLIGHT_SECTIONS = Object.freeze([
  ['built', /^###\s+what gets built\b/im],
  ['notBuilt', /^###\s+what (doesn'?t|does not|is not|isn'?t)\b/im],
  ['decisions', /^###\s+decisions\b/im],
  ['needsYou', /^###\s+what needs you\b/im],
]);

/** Requirement definitions: a bullet starting with a bold ID, e.g. `- **A1 Preset.**` */
const REQ_DEF = /^\s*[-*]\s+\*\*([A-Z][A-Z0-9]{0,3}\d+)\b/gm;
const ID_TOKEN = /\b([A-Z][A-Z0-9]{0,3}\d+(?:\.\d+)*)\b/g;

export function sectionText(md, headingRe) {
  const m = headingRe.exec(md);
  if (!m) return null;
  const level = (m[0].match(/^#+/) ?? ['##'])[0].length;
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(new RegExp(`^#{1,${level}}\\s`, 'm'));
  return end === -1 ? rest : rest.slice(0, end);
}

export function checkHighlights(md) {
  const hl = sectionText(md, /^##\s+highlights\b.*$/im);
  if (hl === null) return { ok: false, missing: ['Highlights section'] };
  const missing = HIGHLIGHT_SECTIONS.filter(([, re]) => !re.test(hl)).map(([k]) => k);
  return { ok: missing.length === 0, missing };
}

export function parseRequirements(md) {
  const ids = [...new Set([...md.matchAll(REQ_DEF)].map((m) => m[1]))];
  const highlights = checkHighlights(md);
  const reasons = [];
  if (!highlights.ok) reasons.push(`Highlights incomplete: missing ${highlights.missing.join(', ')}`);
  if (ids.length === 0) reasons.push('no requirement IDs found (expected bullets like "- **A1 Title.**")');
  return { ok: reasons.length === 0, ids, highlights, reasons };
}

function tableRows(md) {
  const rows = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|') || /^\|\s*:?-{2,}/.test(t)) continue;
    rows.push(t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  }
  return rows;
}

/**
 * Verification plan: tables whose header has ID, Kind and Proves columns.
 * Kind is `automated` or `human`; Proves lists requirement IDs (ranges like J1–J4 allowed).
 */
export function parseVerificationPlan(md, requirementIds) {
  const highlights = checkHighlights(md);
  const checks = [];
  const reasons = [];
  let header = null;
  for (const row of tableRows(md)) {
    const lower = row.map((c) => c.toLowerCase());
    if (lower.includes('id') && lower.includes('kind') && lower.includes('proves')) {
      header = { id: lower.indexOf('id'), kind: lower.indexOf('kind'), proves: lower.indexOf('proves'), check: lower.findIndex((c) => c === 'check'), command: lower.indexOf('command') };
      continue;
    }
    if (!header) continue;
    const id = row[header.id];
    if (!id || !/^[A-Z][A-Z0-9]*\d+$/.test(id)) continue;
    const kind = (row[header.kind] ?? '').toLowerCase();
    if (kind !== 'automated' && kind !== 'human') reasons.push(`check ${id}: kind must be automated or human, got "${row[header.kind] ?? ''}"`);
    checks.push({
      id,
      kind,
      text: header.check >= 0 ? row[header.check] : '',
      command: header.command >= 0 ? stripCode(row[header.command]) || null : null,
      proves: expandIds(row[header.proves] ?? '', requirementIds),
    });
  }
  const covered = new Set(checks.flatMap((c) => c.proves));
  const uncovered = requirementIds.filter((id) => !covered.has(id));
  if (!highlights.ok) reasons.push(`Highlights incomplete: missing ${highlights.missing.join(', ')}`);
  if (checks.length === 0) reasons.push('no checks found (expected a table with ID | Kind | Check | Proves columns)');
  if (uncovered.length) reasons.push(`requirements without a check: ${uncovered.join(', ')}`);
  const dup = checks.map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dup.length) reasons.push(`duplicate check IDs: ${[...new Set(dup)].join(', ')}`);
  return { ok: reasons.length === 0, checks, uncovered, highlights, reasons };
}

function stripCode(s) {
  return (s ?? '').replace(/^`+|`+$/g, '').trim();
}

/** Expand "A1, B2–B4, J1-J3" against the known ID list. */
export function expandIds(text, known = []) {
  const out = [];
  const knownSet = new Set(known);
  const range = /\b([A-Z][A-Z0-9]{0,3}?)(\d+)\s*[–-]\s*\1?(\d+)\b/g;
  let consumed = text;
  for (const m of text.matchAll(range)) {
    const [, prefix, a, b] = m;
    for (let i = Number(a); i <= Number(b); i++) out.push(`${prefix}${i}`);
    consumed = consumed.replace(m[0], ' ');
  }
  for (const m of consumed.matchAll(ID_TOKEN)) out.push(m[1]);
  const uniq = [...new Set(out)];
  return known.length ? uniq.filter((id) => knownSet.has(id)) : uniq;
}

/** Bulleted, bold-ID items with [bracketed] citations: `- **S4.2 Ops.** ... [J4, J2]` */
function parseCitedItems(md, idPrefix) {
  const items = [];
  const re = new RegExp(`^\\s*(?:[-*]|#{2,4})\\s+\\**(${idPrefix}\\d+(?:\\.\\d+)*)\\b`, 'gm');
  const matches = [...md.matchAll(re)];
  matches.forEach((m, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : md.length;
    const body = md.slice(m.index, end);
    const cites = [...body.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]).filter((c) => !/^https?:/.test(c)).join(', ');
    items.push({ id: m[1], body, citeText: cites });
  });
  return items;
}

export function parseSpecs(md, requirementIds) {
  const items = parseCitedItems(md, 'S').map((it) => ({ id: it.id, cites: expandIds(it.citeText, requirementIds) }));
  const reasons = [];
  const bad = items.filter((it) => it.cites.length === 0).map((it) => it.id);
  // Parent headings (S3) may carry only children citations; a spec item is "bad" only if neither it nor a child cites.
  const trulyBad = bad.filter((id) => !items.some((o) => o.id.startsWith(id + '.') && o.cites.length));
  const cited = new Set(items.flatMap((it) => it.cites));
  const uncited = requirementIds.filter((id) => !cited.has(id));
  if (items.length === 0) reasons.push('no spec items found (expected "- **S1 Title.** ... [A1]")');
  if (trulyBad.length) reasons.push(`spec items citing no requirement: ${trulyBad.join(', ')}`);
  if (uncited.length) reasons.push(`requirements no spec item cites: ${uncited.join(', ')}`);
  return { ok: reasons.length === 0, items, uncited, reasons };
}

/**
 * Implementation plan: a table with Step | Work | Specs | Checks columns, plus an optional
 * "Check commands" table with Check | Command | Cwd columns.
 */
export function parsePlan(md, specIds, checkIds) {
  const steps = [];
  const commands = {};
  const reasons = [];
  let mode = null;
  let h = null;
  for (const row of tableRows(md)) {
    const lower = row.map((c) => c.toLowerCase());
    if (lower.includes('step') && lower.includes('specs') && lower.includes('checks')) {
      mode = 'steps';
      h = { step: lower.indexOf('step'), work: lower.indexOf('work'), specs: lower.indexOf('specs'), checks: lower.indexOf('checks') };
      continue;
    }
    if (lower.includes('check') && lower.includes('command')) {
      mode = 'cmds';
      h = { check: lower.indexOf('check'), command: lower.indexOf('command'), cwd: lower.indexOf('cwd') };
      continue;
    }
    if (mode === 'steps') {
      const id = row[h.step];
      if (!/^P\d+$/.test(id ?? '')) continue;
      steps.push({
        id,
        work: row[h.work] ?? '',
        specs: expandIds(row[h.specs] ?? '', []).filter((x) => x.startsWith('S')),
        checks: expandIds(row[h.checks] ?? '', checkIds),
      });
    } else if (mode === 'cmds') {
      const id = row[h.check];
      if (!id) continue;
      commands[id] = { command: stripCode(row[h.command]), cwd: h.cwd >= 0 ? stripCode(row[h.cwd]) || null : null };
    }
  }
  const specSet = new Set(specIds);
  if (steps.length === 0) reasons.push('no plan steps found (expected a Step | Work | Specs | Checks table)');
  for (const st of steps) {
    if (st.specs.length === 0) reasons.push(`step ${st.id} cites no spec item`);
    const unknown = st.specs.filter((s) => !specSet.has(s) && !specIds.some((k) => k.startsWith(s + '.')));
    if (unknown.length) reasons.push(`step ${st.id} cites unknown spec items: ${unknown.join(', ')}`);
    if (st.checks.length === 0) reasons.push(`step ${st.id} cites no check`);
  }
  return { ok: reasons.length === 0, steps, commands, reasons };
}
