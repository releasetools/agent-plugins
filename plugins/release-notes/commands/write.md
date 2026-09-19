---
name: write
description: Write the release note for the change on this branch, into the pull request and the changelog
argument-hint: "[--pr <number>] [--base <ref>] [--path <dir>] [--none]"
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs:*)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs":*)
  - Bash(git diff:*)
  - Bash(git status:*)
  - Bash(git log:*)
  - Read
  - Write
---

Write this change's release note. Arguments: `$ARGUMENTS`.

Read the write skill first, and the release-notes skill it points at. They
carry the one test every change is ruled against, the block it is declared
in, and the shape of an entry. Nothing below repeats them.

**1. What this change is.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs" change
```

Pass through any `--base` or `--path` in the arguments, unchanged. Everything
else it needs it reads from `.releasetools.yaml`.

**2. Rule on the change**, against the one test, from the diff of the range it
printed. Say which of the three outcomes this is: a note already declared, a
note to write, or nothing a reader can observe.

**3. Write it** to the `noteFile` path, show it to the user, then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-notes.mjs" note --pr <number>
```

`--none` instead, for a change a reader cannot observe. Leave `--pr` off when
there is no pull request yet. Read `skipped` in what it prints and tell the
user what it says: a version that has not moved is the usual one, and the
note is not lost, it is in `noteFile`.

Never write a manifest version here. That is a different question, and the
guards on the pull request answer it.
