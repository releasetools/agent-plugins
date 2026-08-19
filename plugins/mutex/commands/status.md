---
name: status
description: Show what you are holding, or who holds a lock you name
argument-hint: "[lock-id]"
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs":*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs" status`

Print that table above **verbatim**, inside a fenced code block, and nothing
else. Do not summarise it, do not turn it into sentences, and do not drop
columns: it is a table so it can be scanned down, and a paragraph cannot be.

One short line after it is welcome when something needs saying - a lock about to
lapse, or nothing held at all. If `$ARGUMENTS` named a lock, run the same
command with that id and print that instead. On its own it asks the table for
this session's locks and nothing else; add `--all` when the question is what
else is in the way, and everybody else's arrive in a second table. This is
read-only: take, release and renew nothing.
