---
name: renew
description: Renew a mutex lock you already hold, extending it before it expires
argument-hint: "<lock-id> [seconds, default 3600]"
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs":*)
---

The helper is [`agent-lock.mjs`](../mutex/agent-lock.mjs), in the mutex
skill's directory beside this one. Run it by its absolute path, written
`<helper>` below.

Run this once, with the first word of the user's arguments as the id and a
number after it, if given, as the seconds:

```bash
node "<helper>" renew <id> --expiration <seconds>
```

Say in one line when it now expires. Renewing only adds time, and it is strict:
the id and the owner must match, and an expired lock is refused rather than
re-taken because somebody else may already have it. If that is the answer, say
the guard has lapsed before anything else.
