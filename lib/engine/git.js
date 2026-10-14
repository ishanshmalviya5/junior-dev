// Git helpers used by the engine (S8.2 rollback, deliver guard, S1.5 exclude).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { EngineError } from './util.js';

export function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new EngineError('git', `git ${args.join(' ')} failed in ${cwd}: ${(e.stderr || e.message).toString().trim()}`);
  }
}

export const isRepo = (dir) => git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }) === 'true';
export const topLevel = (dir) => git(dir, ['rev-parse', '--show-toplevel']);
export const head = (dir) => git(dir, ['rev-parse', 'HEAD'], { allowFail: true });
export const branch = (dir) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
export const gitDir = (dir) => path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir']));

/** S1.5: add `relPath` to the repo's .git/info/exclude (idempotent). */
export function excludeLocally(repoDir, relPath) {
  const file = path.join(gitDir(repoDir), 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = relPath.endsWith('/') ? relPath : relPath + '/';
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (cur.split('\n').some((l) => l.trim() === line || l.trim() === '/' + line)) return false;
  fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + '/' + line + '\n');
  return true;
}

/** S8.2: discard a failed attempt. Refuses unless on a junior-dev/* branch. */
export function rollback(repoDir, ref) {
  const b = branch(repoDir);
  if (!b.startsWith('junior-dev/')) throw new EngineError('guard', `refusing to reset ${repoDir}: branch ${b} is not a junior-dev/* branch`);
  git(repoDir, ['reset', '--hard', ref]);
  git(repoDir, ['clean', '-fd']);
}

/** Commit everything on the run branch (doc files are excluded locally, so never staged). */
export function commitAll(repoDir, message) {
  const b = branch(repoDir);
  if (!b.startsWith('junior-dev/')) throw new EngineError('guard', `refusing to commit in ${repoDir}: branch ${b} is not a junior-dev/* branch`);
  git(repoDir, ['add', '-A']);
  const staged = git(repoDir, ['diff', '--cached', '--name-only']);
  if (!staged) return null;
  git(repoDir, ['commit', '-q', '--no-verify', '-m', message]);
  return head(repoDir);
}

/** v2-04: lines added to the work path (staged and untracked included) that carry the debug-log tag. */
export function taggedLines(repoDir, tag) {
  git(repoDir, ['add', '-A']);
  const diff = git(repoDir, ['diff', '--cached', '-U0', '--no-color']);
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++') && l.includes(tag));
}

/** Deliver guard: doc files (under `prefix`) tracked or staged in the repo. */
export function trackedUnder(repoDir, prefix) {
  const tracked = git(repoDir, ['ls-files', '--', prefix], { allowFail: true }) ?? '';
  const staged = git(repoDir, ['diff', '--cached', '--name-only', '--', prefix], { allowFail: true }) ?? '';
  return [...new Set([...tracked.split('\n'), ...staged.split('\n')].filter(Boolean))];
}

/** Doc files that ever appeared in commits between base and HEAD. */
export function committedUnder(repoDir, base, prefix) {
  const out = git(repoDir, ['log', '--name-only', '--pretty=format:', `${base}..HEAD`, '--', prefix], { allowFail: true }) ?? '';
  return [...new Set(out.split('\n').filter(Boolean))];
}

/** E3: prepare the run workspace for one repo. */
export function prepareWorkspace(repoDir, { mode, branch: br, worktreesRoot }) {
  const baseRef = head(repoDir);
  if (mode === 'worktree') {
    const id = crypto.createHash('sha256').update(path.resolve(repoDir)).digest('hex').slice(0, 8);
    const wt = path.join(worktreesRoot, `${path.basename(repoDir)}-${id}--${br.replace(/\//g, '-')}`);
    if (fs.existsSync(wt)) {
      // reuse only our own worktree of this repo on this branch
      const common = path.resolve(wt, git(wt, ['rev-parse', '--git-common-dir']));
      if (common !== gitDir(repoDir) || branch(wt) !== br) throw new EngineError('guard', `${wt} exists but is not the ${br} worktree of ${repoDir}`);
      return { workPath: wt, baseRef: git(repoDir, ['merge-base', 'HEAD', br]) };
    }
    const exists = git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${br}`], { allowFail: true });
    git(repoDir, exists ? ['worktree', 'add', '-q', wt, br] : ['worktree', 'add', '-q', '-b', br, wt, baseRef]);
    return { workPath: wt, baseRef };
  }
  const existing = git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${br}`], { allowFail: true });
  // rollback runs `git clean -fd` on the run branch, so an in-place run needs a fully clean checkout
  const dirty = git(repoDir, ['status', '--porcelain', '--untracked-files=normal']);
  if (dirty) throw new EngineError('guard', `${repoDir} has uncommitted or untracked files; commit, stash or ignore them, or use worktree mode, before an in-place run`);
  git(repoDir, existing ? ['checkout', '-q', br] : ['checkout', '-q', '-b', br]);
  return { workPath: repoDir, baseRef };
}
