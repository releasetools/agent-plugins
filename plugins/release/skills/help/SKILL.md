---
name: help
description: What the release plugin does, and what it will not
argument-hint: ""
---

Tell the user this, in your own words but no longer, and run nothing. Name
each entry the way their client invokes it: `/release:release` in Claude Code,
`$release:release` in Codex.

- `/release:release <version> [--path <dir>]` - run a release's steps in
  order: the prechecks, the changelog entry, the version bump, the pull
  request and its checks, the merge, the wait for the merged commit to go
  green, and publication. Asking for a release in plain words, such as "cut a
  release, version 1.2.3", runs the same steps. The version is bare, `1.2.3`;
  `v1.2.3` is its tag
- `/release:setup [tag | dispatch | both]` - declare what starts a release's
  publish workflow, pushing the tag or dispatching the workflow, and change
  that workflow to match, as a pull request. It runs only when called by name

What each step needs comes from `.releasetools.yaml`: which branch a release
is cut from, the workflow that has to be green, the workflow that publishes and
whether a tag push or a dispatch starts it, and the command that sets the
project's version.

It stops at the first refusal rather than working around it, and it never
moves a tag, forces anything, or releases a version nobody named.

It needs [releasetools/cli](https://github.com/releasetools/cli) for the
checks, and the release-notes plugin for the entry.
