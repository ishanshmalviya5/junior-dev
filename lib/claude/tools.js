// Claude Code host: root tools that exist only here.
import { hub, handleForSession } from '../host/hub.js';

const TEXT = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] };

export const claudeRootTools = [
  {
    name: 'jd_answer',
    description:
      "junior-dev: the developer's pending questions (human checks, queued questions) that the unattended run could not put to them directly. With no arguments, lists them. With answers [{id, selected?: [labels], custom?: text}], records the developer's own answers and lets the run continue. Only pass answers the developer actually gave you.",
    parameters: {
      type: 'object',
      properties: {
        answers: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, selected: { type: 'array', items: { type: 'string' } }, custom: { type: 'string' } }, required: ['id'] } },
      },
      required: [],
      additionalProperties: false,
    },
    output: TEXT,
    async execute(args, exec) {
      const agent = exec.agent;
      const h = handleForSession(agent.id, agent.session?.header?.cwd);
      if (!h) throw new Error('No junior-dev run is attached to this chat.');
      const inbox = hub.claude?.inbox;
      if (!inbox) throw new Error('the junior-dev inbox is not running');
      const answers = typeof args.answers === 'string' ? JSON.parse(args.answers) : args.answers;
      if (answers?.length) inbox.answer(h, answers);
      return JSON.stringify({ pending: inbox.pending(h), notes: inbox.drainNotes(h) }, null, 2);
    },
  },
];
