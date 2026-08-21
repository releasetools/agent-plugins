---
name: name
description: Derive the lock id for a resource, so every agent computes the same one
argument-hint: "<kind> [args...]"
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs":*)
---

Run this once, passing `$ARGUMENTS` through as the kind and its arguments:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs" name <kind> [args...]
```

`issue`, `pr`, `mr`, `branch`, `release`, `admin` and `wiki` read the origin
remote, or `--repo <owner>/<name>` when the user named another repository.
`env`, `db`, `pkg`, `dns`, `tf`, `host`, `role`, `cron`, `announce`, `secret`,
`notion page|db` and `doc` need no repository, and `check <id>` validates an id
the user already has.

Print the id it returns, alone, and stop. No lock is taken and nothing is
looked up, so there is nothing to summarise. If it exits 2 the input broke a
naming rule and the message names it - quote that instead of composing an id
by hand, which is exactly what this command exists to prevent.
