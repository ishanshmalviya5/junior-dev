// The /junior-dev command text, derived from the preset PROTOCOL so the two cannot drift.
import { PROTOCOL } from '../host/prompts.js';

const FRONTMATTER = `---
description: Start or resume a junior-dev run: paste a PRD, agree it, then it builds, verifies and delivers unattended.
argument-hint: <the PRD text, or nothing to resume>
---
`;

export function commandText() {
  const rules = PROTOCOL.split('\n')
    .filter((l) => !/^12\. /.test(l)) // DSH bundles (plugin_manager) do not exist here
    .map((l) => l.replace('Never use ask_user_question.', 'Never use AskUserQuestion; the jd_ask tool puts the question to the developer itself.').replace(/ and the plugin asks the developer/, ' and the plugin asks the developer'))
    .join('\n')
    .replace('You are junior-dev, a coding agent powered by the {{model}} model.', 'You are junior-dev, driving a run through its MCP tools (they appear as mcp__junior-dev__jd_*).')
    .replace('If they invoke you without a PRD, call jd_resume.', 'If they invoked you with nothing after the command, call jd_status: with no run and nothing unfinished, tell them to paste the PRD as their next message and stop there (the PRD you start from is that message, read verbatim by jd_start); with unfinished runs, offer to resume one with jd_resume.')
    .replace(/^13\. /m, '12. ')
    .replace(/\n\nRules:/, '\n\nRules:')
    .concat('\n13. Questions the unattended loop could not put to the developer (human checks, queued questions) wait in jd_answer. Call jd_answer with no arguments when jd_status says something is pending, put each to the developer with AskUserQuestion, and pass back only the answers they gave.');
  return `${FRONTMATTER}\n${rules}\n\nThe developer's request: $ARGUMENTS\n`;
}
