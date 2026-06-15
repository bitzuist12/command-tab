#!/usr/bin/env node
'use strict';

/**
 * One-command setup: scaffold a private context folder from examples/context.
 *
 *   npm run init
 *
 * Creates ./command-tab-context (or COMMAND_TAB_CONTEXT_DIR) with starter
 * tasks/notes/whatsapp/settings and a cards/ folder. Never overwrites an
 * existing context folder.
 */

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'examples', 'context');
const dest = process.env.COMMAND_TAB_CONTEXT_DIR || path.join(process.cwd(), 'command-tab-context');

if (!fs.existsSync(src)) {
  console.error(`Template not found at ${src}.`);
  process.exit(1);
}
if (fs.existsSync(dest)) {
  console.log(`Context folder already exists: ${dest}`);
  console.log('Nothing copied. Edit files in its cards/ folder to customize.');
  process.exit(0);
}

fs.cpSync(src, dest, { recursive: true });
console.log(`Created ${dest} from examples/context.`);
console.log('Next: `npm run connector`, then add cards in:');
console.log(`  ${path.join(dest, 'cards')}`);
