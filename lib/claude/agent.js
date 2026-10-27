// An "agent" in the shape the host tools and the gate read (id, session.header, deriveMessages), built from what
// Claude Code gives us: the transport's identity and the developer's latest prompt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { jdHome } from '../host/hub.js';

/** The UserPromptSubmit hook writes the developer's prompt here, so jd_start reads the PRD verbatim, not as the model retyped it. */
export const promptFile = (cwd) => path.join(jdHome(), 'prompts', `${crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16)}.txt`);

/** Where the driver for a project folder advertises its port and secret to the hooks. */
export const driverFile = (cwd) => path.join(jdHome(), 'drivers', `${crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16)}.json`);

export function shimAgent({ role, id, cwd, parent }) {
  const header = { cwd };
  if (role === 'worker') Object.assign(header, { delegationDepth: 1, origin: 'subagent', parentSession: parent ?? null });
  return {
    id,
    session: {
      header,
      deriveMessages() {
        if (role === 'worker') return [];
        try {
          return [{ role: 'user', content: [{ type: 'text', text: fs.readFileSync(promptFile(cwd), 'utf8') }] }];
        } catch {
          return [];
        }
      },
    },
  };
}
