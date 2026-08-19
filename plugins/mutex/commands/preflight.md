---
name: preflight
description: Check whether mutex can reach its lock table here
argument-hint: ""
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs":*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs" preflight --grant`

Report that in one or two sentences: ready or not, how it reaches the database,
and the name locks will be taken under. Mention the permission rules only if it
added some or could not. If it is not ready, quote the remedy verbatim.

Run nothing else - no profile, no server, and never the connection string.
