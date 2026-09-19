---
name: help
description: What the release-notes plugin does, and what it will not
argument-hint: ""
---

Tell the user this, in your own words but no longer, and run nothing:

- `/release-notes:write` - write the release note for the change on this
  branch, into the pull request's description and into the changelog of every
  project the change lands in
- `/release-notes:prepare <version>` - collate a release's entry from the
  notes its changes declared, ruling on the ones that declared none, into
  `CHANGELOG.md` and `$GIT_DIR/RELEASE_EDITMSG`
- `/release-notes:draft` - the old name for `prepare`, which it runs

A change declares its note in a fenced `release-note` block, and that note is
what gets published, taken as written. A change with no block is ruled against
one test, can a person running the software observe it, and the ruling is
shown before anything is written.

Which projects exist, where each keeps its version and changelog, and which
conventions the repository follows are read from `.releasetools.yaml`.

It writes files and stops. It never tags, commits, pushes or publishes, and it
never picks the version number.
