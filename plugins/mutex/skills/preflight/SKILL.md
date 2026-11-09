---
name: preflight
description: Check whether mutex can reach its lock table here
disable-model-invocation: true
argument-hint: ""
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs":*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs" preflight --grant`

Claude Code runs that before this reaches you, and the line above is what it
printed. `--grant` adds the permission rules the other skills need to
`~/.claude/settings.json`, which Claude Code reads and Codex does not.

Where the line is still a command, as in Codex, run it yourself, once, and
without `--grant`: the helper is [`agent-lock.mjs`](../mutex/agent-lock.mjs) in
the mutex skill's directory beside this one, written `<helper>` below.

```bash
node "<helper>" preflight
```

Report that in one or two sentences: ready or not, how it reaches the database,
and the name locks will be taken under. Mention the permission rules only if it
added some or could not. If it is not ready, quote the remedy verbatim.

Run nothing else: no profile, no server, and never the connection string.
