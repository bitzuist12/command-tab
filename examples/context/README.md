# Command Tab Context Folder

Copy this folder to a private location and point Command Tab at it:

```bash
cp -R examples/context ~/command-tab-context
COMMAND_TAB_CONTEXT_DIR=~/command-tab-context npm run connector
```

Files in this folder are local user context. Do not commit your real context folder.

Expected files:

- `tasks.json`
- `whatsapp.json`
- `notes.json`
- `settings.json`
