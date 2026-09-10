---
name: help
description: What the release-notes plugin does, and what it will not
argument-hint: ""
---

Tell the user this, in your own words but no longer, and run nothing:

- `/release-notes:draft <version>` - rule on every commit since the last tag,
  then write the entry to `CHANGELOG.md` and to `$GIT_DIR/RELEASE_EDITMSG`

Every commit in the range is ruled against one test, can a person running the
software observe it, and the ruling is shown before anything is written. A
commit that changes nothing a user sees gets no entry, and a class of them
gets no entry either.

It writes two files and stops. It never tags, commits, pushes or publishes,
and it never picks the version number.
