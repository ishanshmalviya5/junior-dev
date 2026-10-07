// Permission classifier (S16, E4, C1): local | remote-read | remote-write.

const WRITE_VERBS = /^(create|update|delete|remove|send|post|publish|add|edit|set|write|merge|transition|trigger|patch|bulk|upload|insert|move|share|trash|archive|close|assign|comment|reply|respond)/i;

/** Split a shell command into simple segments on ; && || | and newlines (quotes respected). */
export function segments(cmd) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      cur += ch;
      if (ch === q && cmd[i - 1] !== '\\') q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && cmd[i + 1] === '&')) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  // $(...) and backticks: classify inner commands too
  for (const m of cmd.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) out.push(...segments(m[1] ?? m[2] ?? ''));
  return out;
}

function words(seg) {
  const w = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  // drop env assignments and common wrappers
  for (;;) {
    if (!w.length) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || ['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice', 'caffeinate', 'xargs'].includes(w[0])) {
      w.shift();
      continue;
    }
    if (w[0] === 'timeout' || w[0] === 'gtimeout') {
      w.splice(0, 2);
      continue;
    }
    break;
  }
  return w.map((x) => x.replace(/^["']|["']$/g, ''));
}

function classifySegment(seg) {
  const w = words(seg);
  if (w.length === 0) return { kind: 'local' };
  const [cmd0, a1 = '', a2 = ''] = w;
  const cmd = cmd0.split('/').pop();
  const rest = w.slice(1).join(' ');
  // nested shells and eval: classify the inner command (the most restrictive part wins)
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'].includes(cmd)) {
    const ci = w.findIndex((x, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(x));
    if (ci > 0 && w[ci + 1] !== undefined) return { ...classify('bash', { command: w[ci + 1] }), nested: true };
    return { kind: 'local' };
  }
  if (cmd === 'eval') return { ...classify('bash', { command: w.slice(1).join(' ') }), nested: true };
  if (cmd === 'git') {
    let i = 1;
    while (i < w.length && w[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(w[i]) ? 2 : 1;
    const sub = w[i] ?? '';
    if (sub === 'push') return { kind: 'remote-write', op: 'git-push', args: w };
    if (sub === 'remote' && /\b(set-url|add|remove|rm|rename)\b/.test(rest)) return { kind: 'remote-write', op: 'git-remote' };
    if (['fetch', 'pull', 'ls-remote', 'clone'].includes(sub)) return { kind: 'remote-read', op: `git-${sub}` };
    return { kind: 'local' };
  }
  if (cmd === 'gh') {
    if (a1 === 'pr' && a2 === 'create') return { kind: 'remote-write', op: 'gh-pr-create', args: w };
    if (a1 === 'pr' && ['view', 'list', 'diff', 'checks', 'status'].includes(a2)) return { kind: 'remote-read' };
    if (a1 === 'api') {
      const m = rest.match(/(?:-X|--method)[\s=]+([A-Za-z]+)/);
      const hasFields = /\s(-f|-F|--field|--raw-field|--input)\b/.test(' ' + rest);
      if ((m && m[1].toUpperCase() !== 'GET') || (!m && hasFields)) return { kind: 'remote-write', op: 'gh-api' };
      return { kind: 'remote-read' };
    }
    if (['view', 'list', 'status', 'diff', 'checks', 'search', 'browse'].includes(a2) || ['search', 'status', 'auth', 'browse'].includes(a1)) return { kind: 'remote-read' };
    return { kind: 'remote-write', op: `gh-${a1}-${a2}` };
  }
  if (cmd === 'curl' || cmd === 'wget' || cmd === 'http' || cmd === 'xh') {
    const m = rest.match(/(?:-X|--request|--method)[\s=]+([A-Za-z]+)/);
    const data = /(?:^|\s)(-d|--data\S*|-F|--form|-T|--upload-file|--post-data|--post-file|--json)\b/.test(rest);
    if ((m && m[1].toUpperCase() !== 'GET' && m[1].toUpperCase() !== 'HEAD') || data) return { kind: 'remote-write', op: 'http-write' };
    return { kind: 'remote-read' };
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && w.includes('publish')) return { kind: 'remote-write', op: 'publish' };
  if (cmd === 'docker' && ['push', 'login'].includes(a1)) return { kind: 'remote-write', op: 'docker-push' };
  if (['psql', 'mysql', 'mongo', 'mongosh', 'redis-cli', 'sqlcmd', 'cqlsh'].includes(cmd)) {
    const local = /(localhost|127\.0\.0\.1|::1|\/tmp\/|\.sock)/.test(rest) || (!/-h\s|--host|:\/\//.test(rest) && cmd !== 'redis-cli');
    if (cmd === 'redis-cli' && !/-h\s|-u\s|--host/.test(rest)) return { kind: 'local' };
    return local ? { kind: 'local' } : { kind: 'remote-write', op: `db-${cmd}` };
  }
  if (cmd === 'aws') {
    const verb = w[2] ?? '';
    return /^(describe|list|get|head)/.test(verb) || a1 === 'sts' ? { kind: 'remote-read' } : { kind: 'remote-write', op: 'aws' };
  }
  if (cmd === 'gcloud' || cmd === 'az') {
    return /\b(describe|list|get|show)\b/.test(rest) ? { kind: 'remote-read' } : { kind: 'remote-write', op: cmd };
  }
  if (cmd === 'kubectl') return ['get', 'describe', 'logs', 'explain', 'version', 'config'].includes(a1) ? { kind: 'remote-read' } : { kind: 'remote-write', op: 'kubectl' };
  if (cmd === 'terraform' || cmd === 'pulumi') return ['apply', 'destroy', 'import', 'up'].includes(a1) ? { kind: 'remote-write', op: cmd } : { kind: 'local' };
  if (['ssh', 'scp', 'sftp'].includes(cmd)) return { kind: 'remote-write', op: cmd };
  if (cmd === 'rsync' && /\S+:\S*/.test(rest)) return { kind: 'remote-write', op: 'rsync' };
  return { kind: 'local' };
}

const RANK = { local: 0, 'remote-read': 1, 'remote-write': 2 };

/**
 * Classify a tool call. Bash: per segment, most restrictive wins. MCP-style tools
 * (names with `__` or `mcp`): by the verb at the start of the last name segment.
 */
export function classify(toolName, args = {}) {
  if (toolName === 'bash' || toolName === 'shell' || toolName === 'pwsh') {
    const cmd = String(args.command ?? args.cmd ?? '');
    let worst = { kind: 'local', segments: [] };
    for (const seg of segments(cmd)) {
      const c = { ...classifySegment(seg), segment: seg };
      worst.segments.push(c);
      if (RANK[c.kind] > RANK[worst.kind]) worst = { ...c, segments: worst.segments };
    }
    return worst;
  }
  const isMcp = /__|^mcp[_-]|\bmcp\b/i.test(toolName);
  if (isMcp) {
    const last = toolName.split(/__|\./).pop().replace(/^mcp[_-]/, '');
    return WRITE_VERBS.test(last) ? { kind: 'remote-write', op: `mcp:${toolName}` } : { kind: 'remote-read', op: `mcp:${toolName}` };
  }
  if (toolName === 'web_fetch' || toolName === 'web_search' || toolName === 'fetch') return { kind: 'remote-read' };
  return { kind: 'local' };
}

/** Is this call allowed under the recorded permissions? */
export function allowed(permissions, cls) {
  if (cls.kind !== 'remote-write') return { ok: true };
  const p = permissions ?? {};
  const segs = cls.segments?.length ? cls.segments.filter((s) => s.kind === 'remote-write') : [cls];
  for (const s of segs) {
    if (s.op === 'git-push') {
      if (!p.push) return { ok: false, reason: 'pushing was not permitted in the interview' };
      const v = checkPush(s.args ?? []);
      if (!v.ok) return v;
      continue;
    }
    if (s.op === 'gh-pr-create') {
      if (!p.pr) return { ok: false, reason: 'opening PRs was not permitted in the interview' };
      continue;
    }
    const pattern = (p.remoteWrites ?? []).find((pat) => matches(pat, s));
    if (!pattern) return { ok: false, reason: `remote write (${s.op ?? 'unknown'}) was not permitted in the interview` };
  }
  return { ok: true };
}

function matches(pattern, seg) {
  if (pattern === '*') return true;
  if (pattern === seg.op) return true;
  try {
    return new RegExp(pattern).test(seg.segment ?? seg.op ?? '');
  } catch {
    return false;
  }
}

const SAFE_PUSH_FLAGS = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--no-verify', '--porcelain', '--progress']);

/** A permitted push: one remote, every refspec targets refs/heads/junior-dev/*, no force/delete/mirror/tags. */
export function checkPush(args) {
  const after = args.slice(args.indexOf('push') + 1);
  const flags = after.filter((x) => x.startsWith('-'));
  const bad = flags.filter((f) => !SAFE_PUSH_FLAGS.has(f) && !/^--(set-upstream|repo)=/.test(f));
  if (bad.length) return { ok: false, reason: `push flags not permitted: ${bad.join(' ')} (force, delete, mirror, all and tags are never allowed)` };
  const [remote, ...refspecs] = after.filter((x) => !x.startsWith('-'));
  if (!remote || refspecs.length === 0) return { ok: false, reason: 'pushes must name the remote and a junior-dev/* branch explicitly' };
  for (const r of refspecs) {
    if (r.startsWith('+')) return { ok: false, reason: `forced refspec ${r} is never permitted` };
    const [src, dst, extra] = r.split(':');
    if (extra !== undefined) return { ok: false, reason: `invalid refspec ${r}` };
    if (src === '') return { ok: false, reason: `deleting ${dst} is never permitted` };
    const target = (dst ?? src).replace(/^refs\/heads\//, '');
    if (!/^junior-dev\/[A-Za-z0-9._\/-]+$/.test(target)) return { ok: false, reason: `pushes may only target junior-dev/* branches (got ${dst ?? src})` };
  }
  return { ok: true };
}
