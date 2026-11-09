---
name: callsign
description: Derive the lock id for a resource, so every agent computes the same one
argument-hint: "<kind> [args...]"
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs":*)
---

The helper is [`agent-lock.mjs`](../mutex/agent-lock.mjs), in the mutex
skill's directory beside this one. Run it by its absolute path, written
`<helper>` below.

Run this once, passing the user's arguments through as the kind and its
arguments:

```bash
node "<helper>" callsign <kind> [args...]
```

`issue`, `pr`, `mr`, `branch`, `release`, `admin` and `wiki` read the origin
remote, or `--repo <owner>/<name>` when the user named another repository.
`env`, `db`, `pkg`, `dns`, `tf`, `host`, `role`, `cron`, `announce`, `secret`,
`notion page|db` and `doc` need no repository, and `check <id>` validates an id
the user already has.

Print the id it returns, alone, and stop. No lock is taken and nothing is
looked up, so there is nothing to summarise. If it exits 2 the input broke a
naming rule and the message names it. Quote that instead of composing an id
by hand, which is exactly what this skill exists to prevent.

If the arguments describe an operation rather than a resource, such as
reviewing something or deploying somewhere, which lock that operation takes is
not this skill's judgment. Read the [naming skill](../naming/SKILL.md) before
answering.
