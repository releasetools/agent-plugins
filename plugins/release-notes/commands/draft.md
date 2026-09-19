---
name: draft
description: Renamed to /release-notes:prepare, which this runs
argument-hint: "<version> [--path <dir>] [--at <rev>]"
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs":*)
  - Read
  - Write
---

This command is now `/release-notes:prepare`. Do the work rather than
refusing: read the prepare command and follow it with `$ARGUMENTS` unchanged.

Say the new name once, in one line, before you start. Do not repeat it
afterwards and do not ask whether to go ahead.
