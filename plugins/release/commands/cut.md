---
name: cut
description: Cut a release: prechecks, notes, bump, pull request, merge, tag, publish
argument-hint: "<version> [--path <dir>]"
allowed-tools:
  - Bash(git:*)
  - Bash(gh:*)
  - Bash(rt:*)
  - Read
  - Write
---

Read ${CLAUDE_PLUGIN_ROOT}/skills/cut/SKILL.md and follow it, with
`$ARGUMENTS` as its arguments.
