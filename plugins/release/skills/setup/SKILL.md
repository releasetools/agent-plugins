---
name: setup
description: Declare how this repository publishes a release, by tag or by dispatch, and make its publish workflow match
disable-model-invocation: true
argument-hint: "[tag | dispatch | both]"
allowed-tools:
  - Bash(git:*)
  - Bash(gh:*)
  - Bash(npx:*)
  - Read
  - Write
  - Edit
---

Set up how this repository publishes a release. The argument, when the user
gives one, is the trigger: `tag`, `dispatch` or `both`. With none, ask.

Read "What the repository declares" in the
[release skill](../release/SKILL.md#what-the-repository-declares) first, and
[FORMAT](https://github.com/releasetools/conventions/blob/main/FORMAT.md#configuration)
rules 18 to 29. They are what the result is checked against, and nothing below
repeats them.

1. Work in a linked worktree, on a new branch from the fetched default branch.
   The main checkout stays as it is.
2. Read `.releasetools.yaml`. Where there is none, run
   `npx @releasetools/config adopt` and show what it wrote.
3. Read every workflow in `.github/workflows/` and show what starts each: a tag
   push, a dispatch and its inputs, or something else. Name the one that
   publishes. Where two could, ask which.
4. Ask which trigger, unless the argument said:
   - `tag`: whoever cuts the release pushes the signed tag on the release
     commit, and the push starts the workflow.
   - `dispatch`: whoever cuts the release runs the workflow with the version,
     and the workflow creates the tag. It is the only one that works where the
     tag names a built tree, such as a GitHub Action whose `dist/` is not
     committed.
   - both: either starts it. Only where a dispatch tags the release commit
     itself; a workflow that tags a built tree takes `dispatch` alone.
5. Write `release.publish` and `release.trigger`. For both, write a list with
   the one the user cuts releases with first.
6. Change the publish workflow until it meets the rules for its trigger,
   changing the least that does. Under `tag`, it starts on
   `push: tags: ['v*.*.*']` and creates or moves no exact tag. Under
   `dispatch`:
   - `workflow_dispatch` takes `version`, bare and required, and `commit`,
     defaulting to `HEAD`;
   - `run-name: Release v${{ inputs.version }}`, so the run says what it
     published;
   - before anything is published, it refuses when `commit` is not `HEAD` and
     `github.sha` differs from it, when a manifest declares another version,
     and when `v<version>` already exists;
   - it creates `v<version>` on the release commit, or on a built commit whose
     body carries `Source-Commit: <repository URL>/commit/<sha>`; with
     `releasetools/actions/signed-push`, that line goes in `body`;
   - it runs what a tag push would have started after publication itself,
     since a tag created with `GITHUB_TOKEN` starts no workflow, and where both
     triggers are listed it creates the tag with that token, so the tag does not
     start this workflow a second time.
7. Show the diff, commit it, push the branch and open a pull request. Do not
   merge it.

An agent does this rather than a GitHub Action because a workflow's own token
cannot write `.github/workflows/`, and which trigger fits is the maintainer's
decision.
