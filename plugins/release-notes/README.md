# release-notes, as an agent plugin

Draft the changelog entry for a release by reading every commit since the last
tag against its own diff, ruling on each one, and writing what survives to
`CHANGELOG.md` and to a scratch file the release itself can publish.

The ruling is the point. A model asked for release notes writes them well and
leaves changes out, so every commit in the range gets a row saying whether a
person running the software can observe it, and the table is on the screen
before a word of the entry is written.

## Install

Add the marketplace once, then install the plugin.

Claude Code:

```shell
claude plugin marketplace add releasetools/agent-plugins
claude plugin install release-notes@release-tools
```

Codex:

```shell
codex plugin marketplace add releasetools/agent-plugins
codex plugin add release-notes@release-tools
```

Hermes and Antigravity clone this repository and read `plugin.json`, so they
install from GitHub with no marketplace to add:

```shell
hermes plugins install releasetools/agent-plugins/plugins/release-notes
agy plugin install https://github.com/releasetools/agent-plugins
```

`agy` takes every plugin in the repository. `hermes` takes the one its
subdirectory names.

## What it needs

`git`, and a repository with commits. `gh` is optional: `--pr` fetches the pull
requests a commit landed through, which is worth a call under a merge workflow
and nothing at all under squash merges, where the commit body already is the
pull request body.

## Commands

| Command                                         |                                            |
| ----------------------------------------------- | ------------------------------------------ |
| `/release-notes:draft <version> [--path <dir>]` | Rule on every commit, then write the entry |
| `/release-notes:help`                           | What the plugin does, and what it will not |

## One subtree, or the whole repository

`--path <dir>` releases a subtree: a plugin in a monorepo, a package in a
workspace. The range covers only the commits that touched it, the entry lands
in `<dir>/CHANGELOG.md`, and the scratch file is that subtree's own, so a
subtree draft and a repository draft can be in flight at once. A subtree is
usually versioned on its own rather than tagged, so pass `--since` with it.

```shell
/release-notes:draft 0.3.0 --path plugins/release-notes
```

## A release written up after the fact

An entry is dated today, which is right for a release being cut now. `--at
<rev>` dates it from that commit instead, so a version released in August and
written up in September is dated August. It is the way to give a subtree that
was versioned before it kept a changelog one section per version, each dated
from the commit that released it.

```shell
/release-notes:draft 0.1.0 --path plugins/mutex --since v0.0.9 --at eb4814e
```

A date read off a commit cannot be mistyped, and cannot contradict the history
the entry describes.

A repository can keep both kinds: one changelog per released thing, and one
for itself. They are drafted separately and nothing reconciles them, so the
repository's entry can summarise what the subtree entries said or say
something none of them did.

## The two files it writes

`CHANGELOG.md` gets a `## <version> - <ISO date>` section above every older
release and below the file's preamble, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories. The file is
created with a preamble when the repository has none.

`RELEASE_EDITMSG` gets the same body with no version heading, for whatever
publishes the release. It lives in `$GIT_DIR` next to git's own
`COMMIT_EDITMSG` and `TAG_EDITMSG`, which puts it outside the work tree, where
nothing can commit it by accident. Resolve it the way the plugin does, never by
joining `.git/`:

```shell
git rev-parse --path-format=absolute --git-path RELEASE_EDITMSG
```

Both halves of that matter. Without `--path-format=absolute` the answer is
relative in a main worktree and absolute in a linked one. With `--git-path` a
linked worktree resolves to its own file, so two worktrees preparing releases
cannot overwrite each other.

A release procedure that reads that file needs to know nothing else about how
the entry was produced:

```shell
gh release create "v${VERSION}" --notes-file "$(git rev-parse --path-format=absolute --git-path RELEASE_EDITMSG)"
```

The file is truncated when a draft starts, so a run that dies halfway leaves an
empty file rather than the previous release's body. If it and `CHANGELOG.md`
ever disagree, `CHANGELOG.md` is the one that went through review.

## What it will not do

It drafts an entry and writes two files. It never tags, commits, pushes,
publishes or opens a pull request, and it never picks the version number: that
is an argument, because a version guessed from commits is a version somebody
has to notice is wrong.

## License

Apache-2.0. See [LICENSE](./LICENSE).
