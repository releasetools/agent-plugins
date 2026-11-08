---
name: cut
description: >
  Cut the version a user names with /release:cut or $release:cut: prechecks,
  notes, bump, pull request, merge, tag, publish. A request to release in
  other words is the release skill's.
argument-hint: "<version> [--path <dir>]"
allowed-tools:
  - Bash(git:*)
  - Bash(gh:*)
  - Bash(rt:*)
  - Read
  - Write
---

In Codex, `$ARGUMENTS` means the arguments supplied with the skill.

Release `$ARGUMENTS`. The argument is the version, with or without a leading
`v`; use the bare `x.y.z` everywhere. With no version, ask for one.

Read the release skill first. It carries the steps, what `.releasetools.yaml`
declares, and what to do where a step refuses. Nothing below repeats it.

Run the five steps in order. Show what each command printed before running the
next, in one line each, and stop at the first refusal.

A `--path <dir>` in the arguments names which project of a monorepo is being
released.

Say where it landed at the end: the tag, the release URL, and the registry URL
where the repository declares one.
