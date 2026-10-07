// S24: tools/pre-execute gate for junior-dev sessions and their workers.
import path from 'node:path';
import { classify, allowed } from '../engine/classify.js';
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

  // E4 / D8: remote writes need recorded permission
  const cls = classify(name, args);
  const verdict = allowed(run.state.settings.permissions, cls);
  if (!verdict.ok) {
    return { kind: 'deny', reason: `junior-dev: ${verdict.reason}. Do not work around this; ${child ? 'log it with jd_block' : 'settle it with the developer through jd_ask'}.` };
  }
  return null;
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
