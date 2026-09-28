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

A release runs the steps below in order. Read each command's result before
running the next, and stop at the first refusal.

Nothing here is worth improvising. Where a step refuses, say what it said and
stop; the fix is a person's decision, not a retry.

## What the repository declares

The synchronized main checkout's `.releasetools.yaml` supplies the release
settings. Step 1 locates and updates that checkout before reading the file:

```yaml
projects:
  - path: ./
    manifest: pyproject.toml
    changelog: CHANGELOG.md
    bump: uv version {version}

release:
  branch: main
  merge: squash
  checks: tests.yml
  publish: publish.yml
  registry: https://pypi.org/pypi/my-package/{version}/json
```

| key        | what it is                                           | default                            |
| ---------- | ---------------------------------------------------- | ---------------------------------- |
| `branch`   | what a release is cut from                           | the remote's default branch        |
| `merge`    | how the pull request lands: squash, rebase or merge  | `squash`                           |
| `checks`   | the workflow that must be green on the merged commit | none, and step 4 skips the wait    |
| `publish`  | the workflow the tag starts, watched to the end      | none, and step 5 stops at the push |
| `registry` | a URL that must 404 before releasing                 | none                               |

`{version}` is the bare version everywhere, with no `v`. `registry` names the
distribution as the registry knows it, which is not always the repository's
name or the package a reader imports.

The release tag is `v<version>`, as defined by the conventions. There is no
tag-shape setting in `.releasetools.yaml`.

A repository declaring several projects releases one of them at a time. Take
the one the user named, and ask when they named none rather than guessing.

## The version

The user gives it. With no version, ask. Never guess one from the commits:
a version guessed wrong is a version somebody has to notice.

## 1. Everything that has to be true first

Run `git worktree list --porcelain` to locate the main checkout. Resolve the
default branch from the remote; its name need not be `main`. Commands below
use `origin`; substitute the repository's configured remote throughout.

Take exclusive ownership of main-worktree updates and this release through
the repository's coordination mechanism. Hold it until publication finishes
or the release stops. Other agents can continue in their linked worktrees.
If ownership cannot be established, stop. `git worktree lock` prevents removal
of a worktree; it does not provide this exclusion.

The main checkout stays on the default branch. Check its branch and status;
stop if it is dirty or on another branch. Synchronize it without discarding
work:

```bash
git -C "<main-worktree>" status --porcelain
git -C "<main-worktree>" branch --show-current
git fetch origin
git -C "<main-worktree>" merge-base --is-ancestor HEAD "refs/remotes/origin/<default-branch>"
git -C "<main-worktree>" merge --ff-only "refs/remotes/origin/<default-branch>"
```

The ancestry check refuses local commits that the remote does not contain,
including a checkout ahead of the remote. A failed fetch stops the release.
Now read `.releasetools.yaml` in the main checkout and resolve `<branch>`.
Configuration in an unrelated feature worktree does not select the release.

For a release from the default branch, `<publication-worktree>` is the
existing main checkout. For another release branch, create a separate
publication worktree at an unused path outside main:

```bash
git worktree add --detach "<publication-worktree>" "refs/remotes/origin/<branch>"
```

For a resumed nondefault release, reuse its separate publication worktree
only when it belongs to this release and is clean. Never borrow another
agent's worktree. Run the prechecks from the selected publication checkout:

```bash
cd "<publication-worktree>"
rt release::prechecks <version> --branch <branch> [--check-registry-url <registry>]
```

That checks the shape of the version, a clean working tree, that the tag is
free on the remote, that the version is after the newest release tag, that
HEAD belongs to the release branch's history, and that the registry does not
already carry it. A detached publication worktree can pass that ancestry check.

`rt` is [releasetools/cli](https://github.com/releasetools/cli), v0.4.0 or
newer, installed with `brew install releasetools/tap/releasetools-cli`. Step 2
needs `version::bump`, which arrived in v0.4.0, and `rt version` says which is
here. Where it is missing or older, say so and stop: every check it runs
refuses when it cannot prove what it was asked to prove, and doing them by hand
is how one gets skipped.

## 2. Prepare in a linked worktree

Create the preparation branch from the fetched tip of `<branch>`, the
configured release branch. For a release from `stable`, that base is
`refs/remotes/origin/stable`; the main checkout stays on the default branch.
Choose an unused linked-worktree path outside main, and keep one writer per
worktree. If creation fails, stop before editing.

```bash
git worktree add --no-track -b release/v<version> "<preparation-worktree>" "refs/remotes/origin/<branch>"
cd "<preparation-worktree>"
```

For a resumed release, reuse its own preparation worktree and branch after
checking their state. An existing name belonging to another task is a refusal.
Run all preparation commands and local tests here. Dependency installation
and build output also belong here, outside the main checkout.

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
git diff
git add -- <release-files>
git commit --message "Release <version>"
git push --set-upstream origin refs/heads/release/v<version>
```

`<release-files>` names the reviewed files from this release, including any
lockfile the bump command changed. Check `git show --stat` before pushing.

## 3. The pull request, and its checks

Run these commands in the preparation worktree. Record the pull request
number as `<pr>` and use it explicitly in the remaining steps.

```bash
gh pr create --base <branch> --title "Release <version>" --body-file "$(git rev-parse --path-format=absolute --git-path RELEASE_EDITMSG)"
gh pr checks <pr> --watch --fail-fast
```

The body is the changelog entry that was just written. It is already the
summary, already the thing a reader reviews, and writing a second one invites
the two to disagree.

`--watch` blocks. On a failure, report which check failed and its URL, and
stop. The branch and the pull request stay; nothing has been tagged and
nothing published.

## 4. Verify the merged commit

Merge the recorded pull request from the preparation worktree. Keep its
branch and checkout in place; cleanup is a separate operation after release.

```bash
gh pr merge <pr> --<merge>
gh pr view <pr> --json state,baseRefName,mergeCommit
```

Continue only when the state is `MERGED`, the base is `<branch>` and
`mergeCommit.oid` is present. A queued merge is still pending. Record that
object ID as `RELEASE_SHA`:

```bash
RELEASE_SHA=$(gh pr view <pr> --json mergeCommit --jq '.mergeCommit.oid')
git fetch origin
git merge-base --is-ancestor "$RELEASE_SHA" "refs/remotes/origin/<branch>"
```

Keep the same ownership of the main checkout. Check that it is still clean
and on the default branch, then repeat step 1's ancestry check and fast-forward
against the freshly fetched default branch. Never switch the preparation
worktree to the default branch.

For a release from another branch, verify that its publication worktree is
clean and still belongs to this release, then update that detached checkout:

```bash
git -C "<publication-worktree>" switch --detach "$RELEASE_SHA"
```

For a default-branch release, publication continues from the main checkout.
Its tip can be newer than the release commit. Read the selected project's
manifest and changelog at `RELEASE_SHA`, using `git show` with their paths,
and verify that they declare the requested version and release entry. Keep
that exact SHA for the remaining commands; a later tip is a different release
candidate and needs its own verification.

```bash
cd "<publication-worktree>"
rt github::await_workflow "$RELEASE_SHA" <checks>
```

Skip the wait only when no checks workflow is configured. Run any required
local builds or tests in a separate linked checkout at `RELEASE_SHA`. Build
release artifacts in that checkout too, keeping output outside main. An
external output directory does not make artifacts built from a newer main
checkout belong to `RELEASE_SHA`. Publish those verified artifacts or use CI
that checks out the release tag's exact commit.

Use `squash` where the repository declares no merge strategy. GitHub signs
the squash commit with its web-flow key. Respect the repository's signing
requirements and branch protections for every merge strategy.

`rebase` keeps the branch's own commits and their messages, and `merge` keeps
the branch as a branch. Declare either where the branch protections allow it.

The checks cover the recorded merged commit. The pull request's checks cover
its preparation branch and do not establish that result.

If it fails, the branch now carries the version bump and no release exists.
Say so plainly. The fix is another pull request and then this skill again, at
the same version, since no tag was created.

## 5. Tag, which is what publishes

From the publication checkout, tag the recorded SHA explicitly. Use the
signing key Git configuration selects.

```bash
git tag --sign v<version> "$RELEASE_SHA" --message "v<version>"
git verify-tag v<version>
git push origin refs/tags/v<version>
```

Pushing the tag is the release. Where the repository declares a `publish`
workflow, watch it to the end:

```bash
gh run list --workflow <publish> --commit "$RELEASE_SHA" --event push --json databaseId,headSha,headBranch,url
gh run watch <publish-run-id> --exit-status
```

Select the run whose `headSha` is `RELEASE_SHA` and whose `headBranch` is the
release tag. If it has not appeared, report publication as pending and wait
for that run. A different release's run does not establish success.

Release ownership when publication finishes or the workflow stops, including
on failure. Report the release URL, and the registry URL where there is one.

## What this never does

Move a tag. A tag names one commit forever, and a version that needs a second
attempt gets the next number. Where a publish workflow fails after it has
already uploaded, re-run that workflow rather than re-tagging.

Force anything, stash the user's work, delete an unmerged branch, or retry a
failed check in the hope that it passes.

Release a version the user did not name.
