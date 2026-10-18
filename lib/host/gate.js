// S24: tools/pre-execute gate for junior-dev sessions and their workers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, allowed, XCODE_TOOL_NAMES } from '../engine/classify.js';
import { PHASES } from '../engine/phases.js';
import { hub, handleForAgent, isChild } from './hub.js';

const FS_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
const CHILD_DENIED = new Set(['subagent', 'subagent_fork', 'subagent_control', 'list_agents', 'workflow', 'ralph']);
const READ_ONLY_CMDS = /^\s*(cat|ls|head|tail|wc|stat|file|less|grep|rg|jq)\b/;

/** Decide one call. Returns null (no opinion) or a deny decision. Pure apart from the hub lookup. */
export function judge(exec, h = handleForAgent(exec.agent)) {
  if (!h) return null;
  const run = h.run;
  const name = exec.name;
  const args = exec.arguments ?? {};
  const child = isChild(exec.agent);

  if (name === 'ask_user_question') {
    return { kind: 'deny', reason: child ? 'junior-dev workers never ask the developer. Record a decision with jd_decide (it parks the item and queues the question) or log a blocker with jd_block.' : 'In junior-dev, ask through jd_ask so every question and answer is recorded.' };
  }

  // Workers work alone and plugin code starts every worker. DSH's tool filter cannot remove these from a child
  // (they live in the child's own scope), so the gate denies them.
  if (child && CHILD_DENIED.has(name)) {
    return { kind: 'deny', reason: 'junior-dev workers work alone: plugin code starts every worker. Do the item yourself, or log a blocker with jd_block.' };
  }

  // v2-10 (ADR 0002): plugin_manager only for the root agent before the build; never for workers
  if (name === 'plugin_manager') {
    const late = PHASES.indexOf(run.state.phase) >= PHASES.indexOf('build');
    if (child || late) return { kind: 'deny', reason: 'junior-dev: plugins are built and installed only before the build, by the root agent. A missing capability now parks the item: queue a question for the developer (jd_decide / jd_block) instead.' };
    return null;
  }

  // J4: the store is written only by plugin code
  const stateDir = path.join(run.dir, 'state');
  const touches = (p) => typeof p === 'string' && path.resolve(exec.agent?.session?.header?.cwd ?? run.sessionFolder, p).startsWith(stateDir);
  if (FS_WRITE_TOOLS.has(name) && (touches(args.path) || touches(args.file_path) || touches(args.filePath))) {
    return { kind: 'deny', reason: 'junior-dev state is written only by the plugin. Use the jd_* tools.' };
  }
  const cmd = String(args.command ?? '');
  const cwd = exec.agent?.session?.header?.cwd ?? run.sessionFolder;
  const stateRefs = [stateDir, path.relative(cwd, stateDir), `${run.name}/state`, 'events.jsonl', 'snapshot.json', '.junior-dev/secret'];
  if (name === 'bash' && stateRefs.some((r) => r && cmd.includes(r)) && !READ_ONLY_CMDS.test(cmd)) {
    return { kind: 'deny', reason: 'junior-dev state is written only by the plugin. Use the jd_* tools.' };
  }
  // docs written only through jd_write_doc (so they are validated and parity-tracked)
  if (FS_WRITE_TOOLS.has(name) && [args.path, args.file_path, args.filePath].some((p) => typeof p === 'string' && path.resolve(exec.agent?.session?.header?.cwd ?? run.sessionFolder, p).startsWith(run.dir + path.sep))) {
    return { kind: 'deny', reason: 'junior-dev documents are written with jd_write_doc so they are validated and tracked.' };
  }

  // X2#2: the loop gives the chat Full access, so the gate keeps workers' writes inside the run's work paths
  // (and the temp dir). Before the stack-specific checks below, after the state/docs checks whose reasons are more specific.
  const roots = child ? workRoots(run) : null;
  if (roots?.length) {
    const inside = insideOf(roots, sourceCheckouts(run));
    const bad = FS_WRITE_TOOLS.has(name)
      ? [args.path, args.file_path, args.filePath].find((p) => typeof p === 'string' && !inside(path.resolve(cwd, expandHome(p))))
      : name === 'bash' ? bashWriteOutside(cmd, typeof args.workdir === 'string' ? path.resolve(cwd, expandHome(args.workdir)) : cwd, inside) : null;
    if (bad) return { kind: 'deny', reason: `junior-dev workers change files only inside the run's work paths (${roots.slice(0, -TEMP_ROOTS.length).join(', ')}); "${bad}" is outside them. Use absolute paths inside a work path, and run commands with workdir set to one.` };
  }

  const cls = classify(name, args);
  // Xcode MCP writes are local file writes too. Their paths are project-navigator paths (or JSON text),
  // not filesystem paths, so every string argument is checked: resolving under, or mentioning, the state dir or the docs.
  // (Bare file names like snapshot.json are left out: app code written through XcodeWrite may well mention them.)
  if (cls.writes) {
    const strs = stringsIn(args);
    const xcodeStateRefs = [stateDir, path.relative(cwd, stateDir), path.relative(run.sessionFolder, stateDir), `${run.name}/state`, '.junior-dev/secret'];
    if (strs.some((s) => touches(s) || xcodeStateRefs.some((r) => r && s.includes(r)))) {
      return { kind: 'deny', reason: 'junior-dev state is written only by the plugin. Use the jd_* tools.' };
    }
    const docRefs = [run.dir, path.relative(run.sessionFolder, run.dir)];
    if (strs.some((s) => path.resolve(cwd, s).startsWith(run.dir + path.sep) || docRefs.some((r) => r && s.includes(r)))) {
      return { kind: 'deny', reason: 'junior-dev documents are written with jd_write_doc so they are validated and tracked.' };
    }
  }

  // v2-12 (ADR 0001): workers reach iOS only through dsh-ios. Any Xcode MCP tool is denied whatever the server is called
  // (after the state/docs checks above, whose reasons are more specific).
  const xc = /^mcp__.+__([^_].*)$/.exec(name);
  if (child && xc && XCODE_TOOL_NAMES.includes(xc[1])) {
    return { kind: 'deny', reason: 'junior-dev workers do not use Xcode MCP tools. Use the dsh-ios tools (ios_*) for builds, tests and the simulator.' };
  }

  // E4 / D8: remote writes need recorded permission
  const verdict = allowed(run.state.settings.permissions, cls);
  if (!verdict.ok) {
    return { kind: 'deny', reason: `junior-dev: ${verdict.reason}. Do not work around this; ${child ? 'log it with jd_block' : 'settle it with the developer through jd_ask'}.` };
  }
  return null;
}

// Writable for workers besides the work paths. /dev/* (null, stdout, a tty) is always fine.
const TEMP_ROOTS = [os.tmpdir(), '/tmp', '/private/tmp'];
// Read-only for workers: running tools from here is fine, changing anything here is not.
const SYSTEM_READ = ['/usr', '/bin', '/sbin', '/opt', '/System', '/Library', '/Applications', '/etc', '/private/etc', '/var/db', path.join(os.homedir(), 'Library', 'Developer')];
const READ_ONLY = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'stat', 'file', 'less', 'grep', 'rg', 'jq', 'echo', 'printf', 'pwd', 'which', 'type', 'sort', 'uniq', 'diff', 'tree', 'basename', 'dirname', 'realpath', 'readlink', 'du', 'df', 'test', '[', 'true', 'false', 'cut', 'tr', 'nl', 'od', 'xxd', 'shasum', 'md5']);
// Read-only unless one of these arguments appears.
const READ_UNLESS = { sed: /^-[a-zA-Z]*i|^--in-place/, find: /^-(delete|exec|execdir|ok|fprint)/, awk: /^-i/ };
const WRITE_CMDS = new Set(['rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'tee', 'ln', 'chmod', 'chown', 'rsync', 'dd', 'truncate', 'unlink', 'install', 'shred', 'ditto']);
const COPY_CMDS = new Set(['cp', 'rsync', 'ditto', 'install', 'ln']);
const PREFIXES = new Set(['sudo', 'env', 'command', 'time', 'nohup', 'exec', 'xargs']);

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const expandHome = (p) => p.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, os.homedir());
const under = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** The folders a worker may change: each repo's work path (worktree, or the checkout itself in place), then TEMP_ROOTS. */
function workRoots(run) {
  const wps = (run.state.settings.repos ?? []).map((r) => r.workPath).filter(Boolean);
  return wps.length ? [...wps, ...TEMP_ROOTS] : [];
}

/** The developer's own checkouts of repos worked in a worktree: never a worker's to change, wherever they are. */
const sourceCheckouts = (run) => (run.state.settings.repos ?? []).filter((r) => r.workPath && path.resolve(r.workPath) !== path.resolve(r.path)).map((r) => r.path);

/**
 * A predicate: is an absolute path inside one of `roots` and not inside one of `outs`
 * (symlinks like /var → /private/var resolved on both sides)?
 */
function insideOf(roots, outs = []) {
  const both = (xs) => [...new Set(xs.flatMap((r) => [path.resolve(r), real(r)]))];
  const ins = both(roots);
  const exs = both(outs);
  const hit = (p, rs) => rs.some((r) => under(p, r) || under(real(p), r));
  return (p) => p.startsWith('/dev/') || (hit(p, ins) && !hit(p, exs));
}

/**
 * Pure apart from realpath: the first path a bash command would change outside the work paths, or null. A heuristic over
 * simple commands (split on ; && || | and newlines, `cd` followed): redirect targets must be inside; a command that is not
 * read-only must have every operand inside, or (not for write commands such as rm, cp, mv) under a system folder it only
 * runs tools from. Heredoc bodies are text, not commands. Code a command runs (node -e, scripts) is not seen.
 */
export function bashWriteOutside(cmd, cwd, inside) {
  const text = String(cmd).replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, (m) => m.split('\n')[0]);
  let at = cwd;
  const abs = (w) => path.resolve(at, expandHome(w));
  const unq = (w) => w.replace(/^['"]+|['"]+$/g, '');
  for (const part of text.split(/&&|\|\||[;|\n]/)) {
    let seg = part;
    // redirections: `> f`, `>> f`, `2> f`; `2>&1` and `>&2` name no file
    for (const m of part.matchAll(/(?:^|[^<>&\d])\d?>>?\s*([^\s;&|()<>]+)/g)) {
      if (m[1].startsWith('&')) continue;
      const t = unq(m[1]);
      if (!inside(abs(t))) return t;
      seg = seg.replace(m[0], ' ');
    }
    const words = seg.trim().split(/\s+/).map(unq).filter(Boolean);
    while (words.length && (PREFIXES.has(words[0]) || /^\w+=/.test(words[0]))) words.shift();
    if (!words.length) continue;
    const [verb, ...rest] = words;
    if (verb === 'cd') { at = abs(rest.find((w) => !w.startsWith('-')) ?? '~'); continue; }
    const base = path.basename(verb);
    if (READ_ONLY.has(base) || (READ_UNLESS[base] && !rest.some((w) => READ_UNLESS[base].test(w)))) continue;
    const writes = WRITE_CMDS.has(base) || (/^(npm|pnpm|yarn|bun)$/.test(verb) && rest.some((w) => w === '-g' || w === '--global'));
    if (/^(npm|pnpm|yarn|bun)$/.test(verb) && writes) return `${verb} ${rest.join(' ')}`.slice(0, 80);
    const ops = rest.map((w) => (w.startsWith('-') ? (w.includes('=') ? w.slice(w.indexOf('=') + 1) : null) : w))
      .filter((op) => op && !/^[a-z][\w+.-]*:\/\//i.test(op)); // flags, URLs
    // a copy only writes its destination (the last operand)
    for (const op of COPY_CMDS.has(base) ? ops.slice(-1) : ops) {
      const p = abs(op);
      if (inside(p)) continue;
      if (!writes && SYSTEM_READ.some((r) => under(p, r))) continue;
      return p;
    }
  }
  return null;
}

/** Every string inside a tool's arguments (nested objects and arrays included). */
function stringsIn(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out);
  return out;
}

export function installGate(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const d = await next();
    if (d.kind !== 'allow') return d;
    try {
      return judge(exec) ?? d;
    } catch (e) {
      hub.logger.warn?.(`junior-dev gate error: ${e.message}`);
      // fail closed for junior-dev sessions only
      return handleForAgent(exec.agent) ? { kind: 'deny', reason: `junior-dev gate error: ${e.message}` } : d;
    }
  });
}
