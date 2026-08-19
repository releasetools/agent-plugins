---
name: renew
description: Renew a mutex lock you already hold, extending it before it expires
argument-hint: "<lock-id> [seconds, default 3600]"
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs":*)
---

Run this once, with the first word of `$ARGUMENTS` as the id and a number
after it, if given, as the seconds:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs" renew <id> --expiration <seconds>
```

Say in one line when it now expires. Renewing only adds time, and it is strict:
the id and the owner must match, and an expired lock is refused rather than
re-taken because somebody else may already have it. If that is the answer, say
the guard has lapsed before anything else.
