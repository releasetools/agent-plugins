---
name: draft
description: Draft a release's changelog entry from the commits since the last tag
argument-hint: "<version>"
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/release-notes/agent-notes.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/release-notes/agent-notes.mjs":*)
  - Read
  - Write
---

Write the changelog entry for `$ARGUMENTS`, the version about to be released.
If no version was given, ask for one. Never guess it from the commits.

Read the release-notes skill first. It carries the test every commit is ruled
against, the shape of an entry, and what never goes in one. Nothing below
repeats it.

**1. What is in scope.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/release-notes/agent-notes.mjs" commits
```

**2. Rule on every commit it listed, one at a time.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/release-notes/agent-notes.mjs" evidence <sha>
```

One row per commit, and show the table. Skipping a commit because it looked
dull is the failure this pass exists to prevent, so every sha in pass 1 gets a
row, including the ones that become nothing.

On a long range, run this pass one commit per subagent. Each call needs only
that commit's evidence and the skill's test, and they do not depend on each
other.

**3. Write the body to the `scratchFile` path from step 1**, entries only, no
version heading. Show it to the user and let them change it before the last
step.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/release-notes/agent-notes.mjs" write <version>
```

Then say where it landed, in one line, and stop. The entry is on the screen
already and does not need summarising.

Do not tag anything, commit anything, push anything or open a pull request.
This command drafts an entry and writes two files. Whatever releases the
version is the user's, or another skill's, to run.
