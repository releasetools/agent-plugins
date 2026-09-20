---
name: write
description: >
  Write the release note for the change on this branch, put it in the pull
  request's description, and add the entry to the changelog of every project
  the change lands in. Use before opening or merging a pull request, when
  asked for this change's release note or changelog entry, or when a change
  is about to be merged without one. Triggers on: release note for this PR,
  changelog entry for this change, note this change, write the release note.
---

# write: one change's note

The note is written by the person who made the change, while they still know
why. Everything this does follows from that: it is run on a branch, before
the change is merged, and it writes what it drafts in the two places a note
survives.

Read the [release-notes skill](../release-notes/SKILL.md) first. It carries
the one test, the block, the shape of an entry and what never goes in one.
Nothing below repeats it.

## 1. What this change is

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs" change
```

One call. It prints the fork point this branch is measured from, the projects
the change lands in with the version and changelog each declares, every commit
with what its subject declares, and the note the branch already carries.
It clears `NOTE_EDITMSG`, so a run that fails leaves nothing behind.

Which projects, which changelogs and which conventions all come from
`.releasetools.yaml` at the repository root. Do not decide any of it yourself:
a note that lands in the wrong package's changelog is worse than no note, and
the file is the only thing standing between those two outcomes.

`config.found` is false where the repository has no such file. Say that, say
that `npx @releasetools/config adopt` writes a starter one, and stop. Nothing
here guesses at a project.

`--base <ref>` when the branch is not against the default branch. `--path
<dir>` to act on one project when the change touched several.

## 2. Rule on the change

Against the one test. Read the diff of the range it printed:

```bash
git diff <forkPoint>..HEAD
git status --short
```

Three outcomes, and say which one this is:

- **A note is already declared.** `note` in the output is it. Leave it alone
  unless the diff contradicts it, and say so if it does.
- **A reader can observe something.** Write one note, and put it in
  `noteFile` exactly as it should be published.
- **A reader can observe nothing.** Declare that, rather than leaving the
  question open: step 3 with `--none`.

Prose only, and no version number in the note. The type in the subject decides
the category, and the version is the manifest's business.

## 3. Put it where it survives

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs" note --pr <number>
```

That reads `NOTE_EDITMSG` and does two things with it. The block goes in the
pull request's description, replacing one already there rather than adding a
second. The entry goes in each changed project's changelog, under the section
for the version its manifest declares and the category its type asks for,
and an entry already there is left alone so a second run changes nothing.

`--none` writes the `NONE` block and no entry. Leave `--pr` off before the
pull request exists: the block then has to reach the description another way,
and the note is still in `NOTE_EDITMSG` either way.

Read what it prints. `skipped` is the part that needs you:

| why                            | what to do                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `is already released`          | the version has not moved yet. Bump it to what the line names, then run this again |
| `excepts changelog-per-change` | the repository collates at release, so the block is the whole job                  |
| `declares no changelog`        | the project keeps none, so the block is the whole job                              |

This never writes a manifest. Which version a change earns is a different
question from what the change did, and the guards in
[releasetools/actions](https://github.com/releasetools/actions) answer it on
the pull request.

## 4. Say what happened

One line per file written, and the note itself. The user is about to merge
this: if the note is wrong, now is when it costs nothing to fix.
