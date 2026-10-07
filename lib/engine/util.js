import crypto from 'node:crypto';

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

export const isoNow = () => new Date().toISOString();

export class EngineError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export const FEATURE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Kebab-case name proposal from free text (first heading or first line). */
export function proposeFeatureName(text) {
  const firstLine = String(text).split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? 'feature';
  const words = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w && !['a', 'an', 'the', 'prd', 'for', 'of', 'and', 'to'].includes(w))
    .slice(0, 5);
  return words.join('-') || 'feature';
}
