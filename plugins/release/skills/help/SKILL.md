---
name: help
description: What the release plugin does, and what it will not
argument-hint: ""
---

Tell the user this, in your own words but no longer, and run nothing. Name
each entry the way their client invokes it: `/release:cut` in Claude Code,
`$release:cut` in Codex.

- `/release:cut <version>` - run a release's steps in order: the prechecks,
  the changelog entry, the version bump, the pull request and its checks, the
  merge, the wait for the merged commit to go green, and publication
- `/release:setup [tag | dispatch | both]` - declare what starts a release's
  publish workflow, pushing the tag or dispatching the workflow, and change
  that workflow to match, as a pull request

What each step needs comes from `.releasetools.yaml`: which branch a release
is cut from, the workflow that has to be green, the workflow that publishes and
whether a tag push or a dispatch starts it, and the command that sets the
project's version.

It stops at the first refusal rather than working around it, and it never
moves a tag, forces anything, or releases a version nobody named.

It needs [releasetools/cli](https://github.com/releasetools/cli) for the
checks, and the release-notes plugin for the entry.
