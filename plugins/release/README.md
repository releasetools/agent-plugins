# release, as an agent plugin

Write a change's release note, prepare a release's changelog, or run a release
through publication. The projects and release settings come from
`.releasetools.yaml`.

## Installing

```console
claude plugin marketplace add releasetools/agent-plugins --scope project
claude plugin install release@release-tools --scope project
```

```console
codex plugin marketplace add releasetools/agent-plugins
codex plugin add release@release-tools
```

`--scope project` declares it in the repository rather than in whoever ran it,
so the next person to cut a release is offered the same plugin.

Hermes and Antigravity install from GitHub:

```console
hermes plugins install releasetools/agent-plugins/plugins/release
agy plugin install https://github.com/releasetools/agent-plugins
```

Antigravity installs every plugin in this repository; Hermes installs `release`.

## Commands

Use `/release:<skill>` in Claude Code and `$release:<skill>` in Codex.

| Skill       | Arguments                                                | What it does                                                 |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| `write`     | `[--pr <number>] [--base <ref>] [--path <dir>] [--none]` | Write this change's note into the pull request and changelog |
| `prepare`   | `<version> [--path <dir>] [--at <rev>]`                  | Collate a release's changelog entry                          |
| `release`   | `<version> [--path <dir>]`                               | Run a release through publication                            |
| `setup`     | `[tag \| dispatch \| both]`                              | Configure the publish workflow through a pull request        |
| `preflight` | `[user \| project]`                                      | Configure Claude Code permissions for publishing             |
| `help`      |                                                          | List the skills and their requirements                       |

Asking for a release in plain words, such as "cut a release, version 1.2.3",
runs `release`. `setup` and `preflight` run only when called by name.
`write` and `prepare` can run independently; neither publishes a release.
Both read the [shared release-note rules](references/release-notes.md) before
drafting. The rules are an internal reference with no slash command.

## From release-notes

Install `release@release-tools` and remove the standalone
`release-notes@release-tools` installation using your client's plugin commands.
Repositories that declare the old plugin should declare `release` instead.
Update saved commands using this table; arguments stay the same.
For `release-notes:release-notes`, call `release:write` or `release:prepare`;
each reads the shared rules as part of its workflow.

| Previous command        | Command in release |
| ----------------------- | ------------------ |
| `release-notes:write`   | `release:write`    |
| `release-notes:prepare` | `release:prepare`  |
| `release-notes:help`    | `release:help`     |

## Pushing the tag in auto mode

The release skill's own pre-approval lasts the turn that started the release,
and a release spends several waiting on checks. Claude Code's auto mode then
refuses to push the tag, since the push publishes. `/release:preflight user`
adds [the rules that let it through](skills/preflight/rules.json) to
`~/.claude/settings.json`, and `/release:preflight project` to the
repository's `.claude/settings.json`, which reaches every machine that clones
it once committed. It shows every missing line and asks first, and configures
Claude Code alone.

## What it needs

The note skills need Node.js 24 or newer and `git`. `gh` is needed when
`write --pr` updates a pull request or `prepare` fetches pull request evidence.
The config reader ships with the plugin; it needs no `npm install`.

`release` also needs [releasetools/cli](https://github.com/releasetools/cli)
v0.4.0 or newer for the checks and bump
(`brew install releasetools/tap/releasetools-cli`), and authenticated `gh`
for the pull request and workflows.

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
  trigger: tag
  registry: https://pypi.org/pypi/my-package/{version}/json
```

| key        | what it is                                                  | default                        |
| ---------- | ----------------------------------------------------------- | ------------------------------ |
| `branch`   | what a release is cut from                                  | the remote's default branch    |
| `merge`    | how the pull request lands: squash, rebase or merge         | `squash`                       |
| `checks`   | the workflow that must be green on the release commit       | none, and the wait is skipped  |
| `publish`  | the workflow that publishes, watched to the end             | none, and it stops at the push |
| `trigger`  | what starts `publish`: `tag`, `dispatch`, or a list of both | `tag`                          |
| `registry` | a URL that must 404 before releasing                        | none                           |

Under `tag` the plugin pushes the signed tag and the push starts `publish`.
Under `dispatch` it runs `publish` with the version and the release commit, and
the workflow creates the tag. `/release:setup` declares which, and changes the
publish workflow to match.

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
publication worktree too, and its preparation branch starts at that release
branch's fetched tip.

|     |                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------- |
| 1   | reserve the main checkout, synchronize it, then run `rt release::prechecks` in the publication checkout |
| 2   | create a linked release worktree, prepare the notes and version, review the files, commit and push      |
| 3   | the pull request, with the changelog entry as its body, and its checks watched                          |
| 4   | merge the recorded PR, synchronize main and verify the exact merged commit                              |
| 5   | under `tag`, sign and push a tag naming that commit; under `dispatch`, run the workflow that tags it    |

The release tag leads back to the PR's merged commit even if the default
branch advances during verification. Under `dispatch` it names that commit, or
a built commit whose `Source-Commit` trailer does. The version and required checks are verified
at that SHA. Local builds and tests use a linked checkout at the verified
release commit, and artifacts are built from that checkout.

## One change at a time

`/release:write` is run on a branch, before the change is merged, which
is while the person who made it still knows why. It rules the change against
the one test, writes the note to `$GIT_DIR/NOTE_EDITMSG`, puts the block in
the pull request's description and the entry in the changelog of every project
the change lands in.

With `--pr <number>`, it measures the change from the branch that pull request
merges into. On a stacked pull request, that keeps the parent branch's changes
out of the note. Before the pull request exists, give `--base <ref>` for a
branch whose base differs from the default branch. An explicit `--base` wins
over `--pr`.

Which projects those are, where each keeps its version and its changelog, and
whether the repository writes entries per change at all are read from
`.releasetools.yaml` at the repository root, the file every releasetools tool
reads. A note that lands in the wrong package's changelog is worse than no
note, and that file is what stands between the two. A repository without one
is told so and nothing is written; `npx @releasetools/config adopt` writes a
starter.

It never writes a manifest version. Where a project's version is one that was
already released, it says so and names what the change asks for instead, and
the note stays in `NOTE_EDITMSG` until the bump lands.

## A note the author wrote

A change can carry its own release note, in a fenced block in its commit
message or pull request description:

````markdown
```release-note
Batch mode processes up to 10,000 records per request. Enable it with the
batch=true query parameter.
```
````

That note is what gets published, taken as written, because the person who
wrote it was there. `NONE` in the block says a reader can observe nothing, and
the commit is ruled that way without its patch being read. A change with no
block is drafted from its diff at release, and `/release:prepare`'s
ruling table says which of the two each row came from.

The block has to reach the commit that lands on the default branch, because
that is the copy a release reads months later. A merge that writes its own
commit body copies the block into it verbatim.

The [releasetools conventions](https://github.com/releasetools/conventions)
define the block, and the subject's
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) type
supplies the category: a `feat` lands under `Added`, a `fix` under `Fixed`,
and a `!` or a `BREAKING CHANGE:` footer makes it breaking. None of that is
guessed from the prose.

## One subtree, or the whole repository

`--path <dir>` releases a subtree: a plugin in a monorepo, a package in a
workspace. The range covers only the commits that touched it, the entry lands
in `<dir>/CHANGELOG.md`, and the scratch file is that subtree's own, so a
subtree draft and a repository draft can be in flight at once. A subtree is
usually versioned on its own rather than tagged, so pass `--since` with it.

```shell
/release:prepare 0.3.0 --path plugins/release
```

## A release written up after the fact

An entry is dated today, which is right for a release being cut now. `--at
<rev>` dates it from that commit instead, so a version released in August and
written up in September is dated August. It is the way to give a subtree that
was versioned before it kept a changelog one section per version, each dated
from the commit that released it.

```shell
/release:prepare 0.1.0 --path plugins/mutex --since v0.0.9 --at eb4814e
```

A date read off a commit cannot be mistyped, and cannot contradict the history
the entry describes.

A repository can keep both kinds: one changelog per released thing, and one
for itself. They are drafted separately and nothing reconciles them, so the
repository's entry can summarise what the subtree entries said or say
something none of them did.

## The files it writes

`CHANGELOG.md` gets a `## <version> - <ISO date>` section above every older
release and below the file's preamble, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories. The file is
created with a preamble when the repository has none.

`RELEASE_EDITMSG` gets the same body with no version heading, for whatever
publishes the release. `NOTE_EDITMSG` beside it holds one change's note while
it is being written. It lives in `$GIT_DIR` next to git's own
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

Move a tag, force anything, stash your work, delete an unmerged branch, retry a
failed check in the hope that it passes, or release a version nobody named.

Where a publish workflow fails after it has already uploaded, the answer is to
re-run that workflow, not to re-tag.

## License

Apache-2.0. See [LICENSE](./LICENSE).
