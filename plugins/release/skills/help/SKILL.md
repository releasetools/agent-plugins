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
- `/release:preflight [user | project]` - add the Claude Code permission
  rules that let a release sign and push its tag after the turn that started
  it, to the user's or the project's `settings.json`, after showing them. It
  runs only when called by name
- `/release:write [--pr <number>]` - write this change's release note into
  the pull request's description and each affected project's changelog
- `/release:prepare <version> [--path <dir>]` - collate a release's entry
  from the notes its changes declare, ruling on changes without a note,
  into `CHANGELOG.md` and the worktree's `RELEASE_EDITMSG` scratch file

`write` and `prepare` read the shared release-note rules before drafting.

What each step needs comes from `.releasetools.yaml`: which branch a release
is cut from, the workflow that has to be green, the workflow that publishes and
whether a tag push or a dispatch starts it, and the command that sets the
project's version.

It stops at the first refusal rather than working around it, and it never
moves a tag, forces anything, or releases a version nobody named.

The note skills need Node.js 24 or newer and `git`; pull request operations
also need `gh`. `write` and `prepare` stop after writing their files or
updating the requested pull request description. Neither commits, tags,
pushes, publishes, or picks a version.

`release` also needs [releasetools/cli](https://github.com/releasetools/cli)
v0.4.0 or newer for its checks and bump, and authenticated `gh` for the pull
request and workflows. It reads the bundled `prepare` skill for its entry.
