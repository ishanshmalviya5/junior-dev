// Regenerate commands/junior-dev.md from PROTOCOL: npm run gen:command
import fs from 'node:fs';
import { commandText } from '../lib/claude/command.js';

fs.writeFileSync(new URL('../commands/junior-dev.md', import.meta.url), commandText());
