---
name: prepare
description: >
  Draft a release's changelog entry from the changes since the last tag:
  take the note each change declared, rule on the ones that declared none,
  and collate them into the section for the version being released. Use
  before tagging a release, when asked what changed since the last release,
  or as a step in a repository's own release procedure. Triggers on:
  prepare the release, release notes for x.y.z, changelog entry for the
  release, what changed since the last release.
---

# prepare: the release's entry

A release is the notes its changes declared, in one section, in the order a
reader scans. What is not declared is ruled from the diff, which is the
fallback rather than the method.

Read the [release-notes skill](../release-notes/SKILL.md) first. It carries
the one test, the block, the shape of an entry and what never goes in one.
Nothing below repeats it.

## The three passes

**Pass 1, scope.** One call, which also clears the scratch file:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs" commits
```

It prints the previous tag, the range, and a row per commit. When
`firstRelease` is true nothing has been released yet, the range is the whole
history, and the entry describes what the software does rather than what
changed in it.

Add `--path <dir>` when the thing being released is a subtree rather than the
repository: a plugin in a monorepo, a package in a workspace. The range then
covers only the commits that touched it, the entry lands in
`<dir>/CHANGELOG.md`, and the scratch file is its own. A subtree is usually
versioned on its own rather than tagged, so pass `--since` with it.

A repository can keep both: one changelog per released thing and another for
itself. They are drafted separately and nothing reconciles them. The
repository's entry can summarise what four subtree entries said, or say
something none of them did.

**Pass 2, rule on each commit.** One call per commit:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs" evidence <sha>
```

Then one row per commit, and show the table:

| Field         | What goes in it                                                 |
| ------------- | --------------------------------------------------------------- |
| `sha`         | as printed                                                      |
| `source`      | `note`, `NONE` or `diff`, from what the change declared         |
| `observable`  | yes or no, against the one test                                 |
| `category`    | the section its type asks for, or one of the six                |
| `breaking`    | yes or no                                                       |
| `entry`       | one sentence: what a person running it sees differently         |
| `evidence`    | the paths in the diff that show it                              |
| `discrepancy` | where the message and the diff disagree, empty when they do not |

A commit whose `note` is declared needs no ruling: the row is the note, and
`source` is `note`. One declaring `NONE` is a ruled row with no entry. Only
the rest cost a reading of the patch, and for those `discrepancy` is the row
that earns the diff: a commit saying "fix typo" that also moves a default is
caught here or nowhere.

`patch` comes back null on a large commit, with `patchOmitted` giving its
length. Rule from the stat and the file list; a diff that long is a rewrite,
a generated file or a first commit, and reading it line by line changes
nothing.

Add `--pulls` to fetch the pull requests a commit landed through, each with
its own block. Try it on one commit first: under squash merges the commit
body already is the pull request body, and then it costs an API call per
commit and adds nothing.

**Under a merge workflow**, a merge commit and the commits it brought in are
one change, and the merge commit's body is where the block is. Rule the merge
commit and skip what is under it, or the same note is counted twice.

**Pass 3, write.** Only from the rows where `observable` is yes, and from
`entry` as the table holds it.

Collapse a class only when a member of it is observable. Nine dependency
bumps that change no behaviour are not one shorter entry, they are no entry.
Several commits producing one observable change are one entry.

Write the body to the `scratchFile` path from pass 1, show it to the user,
then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs" section <version>
```

That puts it in `CHANGELOG.md` under `## <version> - <date>`, above every
older release and below the preamble, and leaves the same bytes in the
scratch file for whatever publishes the release. It refuses a version the
changelog already carries. Pass the same `--path` you passed to `commits`, or
the entry lands in the wrong file. `--at <rev>` dates the entry from that
commit rather than today, for a release written up after the fact.

## A repository that writes its entries per change

Where `.releasetools.yaml` does not except `changelog-per-change`, every
change wrote its own entry as it merged and the section is already there.
Then this pass is an audit: read the section against the range and say what
is missing, rather than writing it again.
