---
name: prepare
description: Prepare a release's changelog entry from the notes its changes declared
argument-hint: "<version> [--path <dir>] [--at <rev>]"
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs":*)
  - Read
  - Write
---

Write the changelog entry for `$ARGUMENTS`, the version about to be released.
If no version was given, ask for one. Never guess it from the commits.

A `--path <dir>` in the arguments releases that subtree rather than the whole
repository. Pass it to both the `commits` call and the `section` call,
unchanged.

An `--at <rev>` dates the entry from that commit rather than today, for a
release being written up after the fact. It belongs on the `section` call
alone.

Read the prepare skill first, and the release-notes skill it points at. They
carry the one test every change is ruled against, the block a change declares
its own note in, and the shape of an entry. Nothing below repeats them.

**1. What is in scope.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs" commits
```

**2. Rule on every commit it listed, one at a time.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs" evidence <sha>
```

One row per commit, and show the table. A commit that declared its own note
needs no ruling, and its row says so; the rest are ruled from the diff.
Skipping a commit because it looked dull is the failure this pass exists to
prevent, so every sha in pass 1 gets a row, including the ones that become
nothing.

On a long range, run this pass one commit per subagent. Each call needs only
that commit's evidence and the skill's test, and they do not depend on each
other.

**3. Write the body to the `scratchFile` path from step 1**, entries only, no
version heading. Show it to the user and let them change it before the last
step.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs" section <version>
```

Then say where it landed, in one line, and stop. The entry is on the screen
already and does not need summarising.

Do not tag anything, commit anything, push anything or open a pull request.
This command drafts an entry and writes two files. Whatever releases the
version is the user's, or another skill's, to run.
