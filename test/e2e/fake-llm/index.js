// TEST ONLY. Intercepts every model call (llm/stream waterfall) and answers from a script:
// - junior-dev root agent: the Nth assistant turn plays step N of $JD_FAKE_SCRIPT (JSON list of
//   {tool, args} or {text}); after the script ends it answers with plain text.
// - anything else (titles, other sessions): a short text answer.
import fs from 'node:fs';

export const name = 'jd-fake-llm';
export const inject = ['llm'];

const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : String(m?.content ?? ''));

function script() {
  try {
    return JSON.parse(fs.readFileSync(process.env.JD_FAKE_SCRIPT, 'utf8'));
  } catch {
    return [];
  }
}

function* toolCall(id, toolName, args) {
  const json = JSON.stringify(args ?? {});
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name: toolName, argumentsDelta: json };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: toolName, arguments: json } };
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

function* text(t) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: t };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: t } };
  yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 10 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

let seq = 0;
export function apply(ctx) {
  ctx.on('llm/stream', async function* (options) {
    const msgs = options.messages ?? [];
    const system = [options.system ?? '', ...msgs.filter((m) => m.role === 'system').map(textOf)].join('\n');
    const firstUser = textOf(msgs.find((m) => m.role === 'user' && (!m.source || m.source.kind === 'user')) ?? {});
    const sc = script();
    const steps = Array.isArray(sc) ? sc : sc.root;
    let list = null;
    // workers: the first user message is the junior-dev brief; pick the matching worker script
    for (const wk of (Array.isArray(sc) ? [] : sc.workers ?? [])) {
      if (new RegExp(wk.match).test(firstUser)) {
        list = wk.steps;
        break;
      }
    }
    if (!list) {
      if (!system.includes('You are junior-dev')) {
        yield* text('Test session');
        return;
      }
      list = steps;
    }
    const turn = msgs.filter((m) => m.role === 'assistant').length;
    let step = list[turn];
    const workdir = firstUser.match(/Work in: ([^\s,]+)/)?.[1] ?? '.';
    if (step) step = JSON.parse(JSON.stringify(step).replaceAll('$PROVIDER', options.provider).replaceAll('$MODEL', options.model).replaceAll('$WORKDIR', workdir));
    if (!step) {
      yield* text('(fake model: script finished)');
      return;
    }
    if (step.text) {
      yield* text(step.text);
      return;
    }
    yield* toolCall(`call_fake_${Date.now()}_${seq++}`, step.tool, step.args);
  });
}
