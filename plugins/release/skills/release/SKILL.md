---
name: release
description: >
  Cut a release: the prechecks, the changelog entry, the version bump, the
  pull request and its checks, the merge, the wait, and the tag that
  publishes. Reads what the repository declares in .releasetools.yaml. Use
  when the user says release, cut a release, ship x.y.z, or publish this
  version. Triggers on: release, cut a release, ship a version, tag and
  publish.
---

# release: one step at a time

A release that goes wrong is on a registry forever. Every step below is one
command. Run them in order, read what each says before running the next, and
stop at the first refusal rather than working around it.

Nothing here is worth improvising. Where a step refuses, say what it said and
stop; the fix is a person's decision, not a retry.

## What the repository declares

Read `.releasetools.yaml` at the root before anything else:

```yaml
projects:
  - path: ./
    manifest: pyproject.toml
    changelog: CHANGELOG.md
    bump: uv version {version}

release:
  branch: main
  tag: v{version}
  checks: tests.yml
  publish: publish.yml
  registry: https://pypi.org/pypi/worktrees/{version}/json
```

| key        | what it is                                           | default                            |
| ---------- | ---------------------------------------------------- | ---------------------------------- |
| `branch`   | what a release is cut from                           | `main`                             |
| `tag`      | the tag's shape                                      | `v{version}`                       |
| `checks`   | the workflow that must be green on the merged commit | none, and step 4 skips the wait    |
| `publish`  | the workflow the tag starts, watched to the end      | none, and step 5 stops at the push |
| `registry` | a URL that must 404 before releasing                 | none                               |

`{version}` is the bare version everywhere, with no `v`.

A repository declaring several projects releases one of them at a time. Take
the one the user named, and ask when they named none rather than guessing.

## The version

The user gives it. With no version, ask. Never guess one from the commits:
a version guessed wrong is a version somebody has to notice.

## 1. Everything that has to be true first

```bash
rt release::prechecks <version> --branch <branch> [--check-registry-url <registry>]
```

That checks the shape of the version, a clean working tree, that the tag is
free on the remote, that the version is after the newest release tag, that
HEAD is on the release branch, and that the registry does not already carry
it.

`rt` is [releasetools/cli](https://github.com/releasetools/cli), installed
with `brew install releasetools/tap/releasetools-cli`. Where it is missing,
say so and stop: every check it runs refuses when it cannot prove what it was
asked to prove, and doing them by hand is how one gets skipped.

## 2. The branch, the notes, and the bump

```bash
git fetch --all --prune
git switch --create release/v<version> --no-track origin/<branch>
```

From `origin/<branch>` rather than the local copy, so a stale checkout cannot
become the release.

Then the entry, with `/release-notes:prepare <version>`. It rules on the
changes since the previous tag, takes the note each one declared, writes
`CHANGELOG.md` and leaves the same body in `$GIT_DIR/RELEASE_EDITMSG`. Do not
write that entry by hand: what publishes the release reads it back out.

Then the version, with the command the project declared:

```bash
rt version::bump <version> --command '<bump>' --manifest <manifest> --dir <path>
```

A project that declares no `bump` is set by hand, and the pull request in step
3 is where that is checked. Never edit a manifest to route around a bump
command that failed: a command that does not do what it says is a bug worth
seeing.

```bash
git add --all
git commit --message "Release <version>"
git push --set-upstream origin refs/heads/release/v<version>
```

Check `git show --stat` before pushing. A bump command often rewrites a
lockfile as well, and a commit missing it fails in CI after the merge rather
than before it.

## 3. The pull request, and its checks

```bash
gh pr create --base <branch> --title "Release <version>" --body-file "$(git rev-parse --path-format=absolute --git-path RELEASE_EDITMSG)"
gh pr checks --watch --fail-fast
```

The body is the changelog entry that was just written. It is already the
summary, already the thing a reader reviews, and writing a second one invites
the two to disagree.

`--watch` blocks. On a failure, report which check failed and its URL, and
stop. The branch and the pull request stay; nothing has been tagged and
nothing published.

## 4. Merge, then wait for the branch

```bash
gh pr merge --rebase --delete-branch
git switch <branch> && git pull --ff-only
rt github::await_workflow "$(git rev-parse HEAD)" <checks>
```

`--rebase` keeps the commit message rather than replacing it with the pull
request title.

The wait matters. A rebase onto a branch that moved is a tree neither side has
tested, and a tag must only ever land on a commit already proved green.

If it fails, the branch now carries the version bump and no release exists.
Say so plainly. The fix is another pull request and then this skill again, at
the same version, since no tag was created.

## 5. Tag, which is what publishes

```bash
git tag --annotate <tag> --message "<tag>"
git push origin refs/tags/<tag>
```

Pushing the tag is the release. Where the repository declares a `publish`
workflow, watch it to the end:

```bash
gh run watch "$(gh run list --workflow <publish> --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Report the release URL, and the registry URL where there is one.

## What this never does

Move a tag. A tag names one commit forever, and a version that needs a second
attempt gets the next number. Where a publish workflow fails after it has
already uploaded, re-run that workflow rather than re-tagging.

Force anything, stash the user's work, delete an unmerged branch, or retry a
failed check in the hope that it passes.

Release a version the user did not name.
