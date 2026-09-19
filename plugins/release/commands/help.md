---
name: help
description: What the release plugin does, and what it will not
argument-hint: ""
---

Tell the user this, in your own words but no longer, and run nothing:

- `/release:cut <version>` - run a release's steps in order: the prechecks,
  the changelog entry, the version bump, the pull request and its checks, the
  merge, the wait for the merged commit to go green, and the tag that
  publishes

What each step needs comes from `.releasetools.yaml`: which branch a release
is cut from, the tag's shape, the workflow that has to be green, the workflow
the tag starts, and the command that sets the project's version.

It stops at the first refusal rather than working around it, and it never
moves a tag, forces anything, or releases a version nobody named.

It needs [releasetools/cli](https://github.com/releasetools/cli) for the
checks, and the release-notes plugin for the entry.
