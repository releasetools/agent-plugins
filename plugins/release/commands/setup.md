---
name: setup
description: Declare how this repository publishes a release, by tag or by dispatch, and make its publish workflow match
argument-hint: "[tag | dispatch | both]"
allowed-tools:
  - Bash(git:*)
  - Bash(gh:*)
  - Bash(npx:*)
  - Read
  - Write
  - Edit
---

Read ${CLAUDE_PLUGIN_ROOT}/skills/setup/SKILL.md and follow it, with
`$ARGUMENTS` as its arguments.
