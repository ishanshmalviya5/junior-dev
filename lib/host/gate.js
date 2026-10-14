// S24: tools/pre-execute gate for junior-dev sessions and their workers.
import path from 'node:path';
import { classify, allowed, XCODE_TOOL_NAMES } from '../engine/classify.js';
import { PHASES } from '../engine/phases.js';
import { hub, handleForAgent, isChild } from './hub.js';

const FS_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
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
