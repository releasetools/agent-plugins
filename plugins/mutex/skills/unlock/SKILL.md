---
name: unlock
description: Hand a mutex lock back
argument-hint: "<lock-id>"
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs":*)
---

The helper is [`agent-lock.mjs`](../mutex/agent-lock.mjs), in the mutex
skill's directory beside this one. Run it by its absolute path, written
`<helper>` below.

Run this once, with the user's argument as the id:

```bash
node "<helper>" unlock <id>
```

It releases under the name this session took the lock with, so nothing else
needs passing. Say in one line whether it went back.

Exit 5 means the lock is somebody else's now: say whose, and do not name them
to take it over unless the user asks for exactly that. If no id was given and
you do not know which lock is meant, run `node "<helper>" status` and reason
from its table instead of guessing.
