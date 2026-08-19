---
name: lock
description: Take a mutex lock around work only one caller may do at a time
argument-hint: "<lock-id> [why you are taking it]"
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs":*)
---

Run this once, with the first word of `$ARGUMENTS` as the id and the rest, if
any, as the reason:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs" lock <id> --reason "<the rest>"
```

An hour, and thirty seconds of waiting, are the defaults - pass `--expiration`
or `--wait` only if the user asked for something else. Then say in one line
what happened: acquired and when it expires, or who is holding it and until
when.

Nothing else. No preflight, no status check, no plan, no summary of what you
are about to do. If no id was given, ask for one. If it exits 3 the connection
string is missing - say so and point at `/mutex:preflight`. If it exits 5, or
anything comes back that these two lines do not cover, read the mutex skill
before saying anything.
