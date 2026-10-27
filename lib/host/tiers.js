// Model tiers: the developer fills named tiers with {provider, model} entries; runs bind roles to a tier, never to a model in code.
import fs from 'node:fs';
import path from 'node:path';
import { jdHome } from './hub.js';

const file = () => path.join(jdHome(), 'tiers.json');
const same = (a, b) => a.provider === b.provider && a.model === b.model;
const TIER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** {tierName: [{provider, model, reasoningEffort?}]}; empty until the developer adds models. */
export function loadTiers() {
  try {
    const t = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return t && typeof t === 'object' && !Array.isArray(t) ? t : {};
  } catch {
    return {};
  }
}

function save(tiers) {
  fs.mkdirSync(jdHome(), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tiers, null, 2));
  fs.renameSync(tmp, file());
}

export function addToTier(tier, { provider, model, reasoningEffort }) {
  if (!TIER_NAME.test(tier ?? '')) throw new Error('tier must be a short name of letters, digits, - or _');
  if (!provider || typeof provider !== 'string' || !model || typeof model !== 'string') throw new Error('a tier entry needs provider and model');
  const tiers = loadTiers();
  const list = (tiers[tier] ??= []);
  const entry = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  const i = list.findIndex((m) => same(m, entry));
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  save(tiers);
  return tiers;
}

export function removeFromTier(tier, { provider, model }) {
  const tiers = loadTiers();
  if (!tiers[tier]) throw new Error(`no tier named ${tier}`);
  tiers[tier] = tiers[tier].filter((m) => !same(m, { provider, model }));
  if (!tiers[tier].length) delete tiers[tier];
  save(tiers);
  return tiers;
}

/** The model a tier currently resolves to (its first entry), tagged with the tier; null when the tier is unknown or empty. */
export function resolveTier(tier) {
  const m = loadTiers()[tier]?.[0];
  return m ? { ...m, tier } : null;
}
