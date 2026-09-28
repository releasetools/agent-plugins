# release, as an agent plugin

Runs the steps a release takes, in order, stopping at the first refusal. What
each step needs comes from `.releasetools.yaml`, so the same command releases a
Python package, a Rust crate and a monorepo's one plugin.

## Installing

```console
claude plugin marketplace add releasetools/agent-plugins --scope project
claude plugin install release@release-tools --scope project
```

```console
codex plugin add release@release-tools
```

`--scope project` declares it in the repository rather than in whoever ran it,
so the next person to cut a release is offered the same plugin.

## What it needs

[releasetools/cli](https://github.com/releasetools/cli) v0.4.0 or newer for the
checks and the bump (`brew install releasetools/tap/releasetools-cli`), `gh`
authenticated for the pull request and the workflows, and the
[release-notes plugin](../release-notes/) for the changelog entry.

## What it reads

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

| key        | what it is                                           | default                        |
| ---------- | ---------------------------------------------------- | ------------------------------ |
| `branch`   | what a release is cut from                           | the remote's default branch    |
| `merge`    | how the pull request lands: squash, rebase or merge  | `squash`                       |
| `checks`   | the workflow that must be green on the merged commit | none, and the wait is skipped  |
| `publish`  | the workflow the tag starts, watched to the end      | none, and it stops at the push |
| `registry` | a URL that must 404 before releasing                 | none                           |

The release tag is `v<version>`, as defined by the conventions. There is no
tag-shape setting in `.releasetools.yaml`.

`bump` is the command the project declares for setting its version, which every
ecosystem ships: `uv version {version}`, `npm version {version}
--no-git-tag-version`, `cargo set-version {version}`. Nothing here parses or
rewrites a manifest.

## The steps

Release preparation runs in a linked worktree and branch owned by this
release. The main checkout stays clean on the remote's default branch. One
operator owns its updates through publication; other agents work in their
own linked checkouts. A release from another branch uses a separate
publication worktree too.

|     |                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------- |
| 1   | reserve the main checkout, synchronize it, then run `rt release::prechecks` in the publication checkout |
| 2   | create a linked release worktree, prepare the notes and version, review the files, commit and push      |
| 3   | the pull request, with the changelog entry as its body, and its checks watched                          |
| 4   | merge the recorded PR, synchronize main and verify the exact merged commit                              |
| 5   | sign a tag naming that commit, push and watch its publish workflow                                      |

The release tag names the PR's merged commit even if the default branch
advances during verification. The version and required checks are verified
at that SHA. Local builds and tests run outside the main checkout.

## What it will not do

Move a tag, force anything, stash your work, delete an unmerged branch, retry a
failed check in the hope that it passes, or release a version nobody named.

Where a publish workflow fails after it has already uploaded, the answer is to
re-run that workflow, not to re-tag.

## License

Apache-2.0. See [LICENSE](./LICENSE).
