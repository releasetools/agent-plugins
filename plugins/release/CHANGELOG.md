# release

Newest release first. Each says what changed, and the choices behind it.

The standalone release-notes plugin's releases are in
[RELEASE-NOTES-CHANGELOG.md](RELEASE-NOTES-CHANGELOG.md).

## 0.6.0 - 2026-11-13

### Changed

Release notes are included in `release@release-tools`. Install `release` and
remove the standalone `release-notes` plugin. Use `/release:write` for a
change's note and `/release:prepare` for a release's changelog, with the same
arguments; Codex uses `$release:write` and `$release:prepare`. Both read the
shared rules internally; the rules have no slash command. Help is available
as `release:help`. `/release:release` prepares its changelog with the bundled
skill.

## 0.5.0 - 2026-11-09

`/release:preflight user` or `/release:preflight project` adds the Claude
Code permission rules that let a release sign and push its tag after the
turn that started it, to `~/.claude/settings.json` or the repository's
`.claude/settings.json`. It shows every missing line and asks first, runs
only when called by name, and configures Claude Code alone.

Where auto mode refuses the tag push, which it does without those rules
since the push publishes, `/release:release` says so and names
`/release:preflight`.

## 0.4.0 - 2026-11-08

### Removed

`/release:cut` is gone. Run `/release:release 1.2.3` in Claude Code or
`$release:release 1.2.3` in Codex, or ask for the release in plain words, which
reaches the same skill in both. It takes the same `<version> [--path <dir>]`.
The version is bare: given `v1.2.3`, it says that is the tag and asks for
`1.2.3`.

### Changed

`/release:setup` runs only when called by name, as `/release:setup` in Claude
Code or `$release:setup` in Codex. Neither client starts it from a
description, since it opens a pull request that changes the publish workflow.

A release asked for in plain words pre-approves `git`, `gh`, `glab` and `rt`
commands for that turn, as `/release:cut` did for `git`, `gh` and `rt`.

A release of one project in a repository that declares several writes its
entry to that project's `CHANGELOG.md`, from that project's commits only. It
used to write a `CHANGELOG.md` at the repository root and take every
project's commits.

### Added

Codex runs `$release:setup` and `$release:help`. It offered
`$release:release` alone before, because it reads no `commands/` from a
plugin that ships an Agent Plugins manifest, and those two were commands.

### Choices

Each entry is one skill in `skills/`, with no command beside it. Claude Code
runs a skill the same way it runs a command, and Codex runs only the skill,
so a command beside it would be a second copy that one client never reads.

## 0.3.0 - 2026-11-04

### Added

A repository that publishes by dispatch is released the way it publishes.
Under `release.trigger: dispatch`, step 5 runs the `publish` workflow with the
bare version and the release commit instead of pushing a tag, then checks that
the tag the workflow created names that commit or carries a `Source-Commit`
trailer naming it. Where the branch moved on after the merge, it dispatches on
a `publish/v<version>` branch at the release commit, so later commits never
ship under the version. Under `tag`, the default, nothing changes.

`/release:setup` declares which trigger a repository uses and changes its
publish workflow to meet the rules for it, as a pull request. It is a command
rather than a GitHub Action because a workflow's own token cannot write
`.github/workflows/`.

### Choices

One key, `release.trigger`, rather than a convention per mechanism: conventions
apply unless excepted, so two rival ones would put every repository in breach
of one, and a repository allowing both would still need a key to say which this
plugin runs.

## 0.2.1 - 2026-09-28

### Fixed

Release preparation runs in a linked worktree while the main checkout stays
clean on the default branch. Publication tags the verified PR merge commit
explicitly, even when the default branch advances during checks. Releases
from another branch use a separate publication checkout, and the publish
workflow is selected by the release commit and tag.

## 0.2.0 - 2026-09-21

A release's pull request lands the way `.releasetools.yaml` says, in the
`merge` key: `squash`, `rebase` or `merge`. It was `--rebase` for everybody
before this, and `squash` where the file leaves it out.

A branch requiring signed commits refuses a rebase merge, because GitHub
replays the author's commits unsigned, and a branch requiring linear history
refuses a merge commit. Squash is the only one both take, and
[`signed-git`](https://github.com/releasetools/conventions/blob/main/conventions/signed-git.md)
had already said so, so a repository declaring nothing was being cut against
its own convention.

The `rt` this needs is named: v0.4.0, where `version::bump` arrived. Step 2
called it from the day this shipped, and an older `rt` answers
`Invalid function name` there.

The declaration example names `my-package` rather than a real distribution.
`registry` is the name the registry knows, which is not always the
repository's, and one copied from an example is checked against somebody
else's package.

The `tag` key is gone from the documentation. There was never one to set:
the format does not define it, `@releasetools/config` does not read it, and
the conventions settle the tag's shape. A repository that declared it got a
key nothing read.

### Choices

The default changed rather than staying where it was. A key with a
backwards-compatible default would have left every repository that declares
nothing on the strategy its own conventions refuse, which is the reading
nobody would choose if they were asked.

## 0.1.0 - 2026-09-20

`/release:cut <version>` runs a release's steps in order: the prechecks, the
changelog entry, the version bump, the pull request and its checks, the merge,
the wait for the merged commit to go green, and the tag that publishes. It
stops at the first refusal and says what refused.

What each step needs is read from `.releasetools.yaml`: the branch a release is
cut from, the workflow that has to be green, the workflow the tag starts, the
URL that must not already carry the version, and the command the project
declares for setting its version. Those keys are the
[releasetools conventions](https://github.com/releasetools/conventions/blob/main/FORMAT.md)
rather than this plugin's own, so a second tool reading the file reads the same
thing.

### Choices

The steps are commands, not a script. An agent that runs them reads what each
one printed and can say what went wrong; a script that wraps them turns a
failure into an exit code and a person into a reader of logs. That is the whole
reason this is a plugin rather than another subcommand.

Nothing here parses a manifest. Every ecosystem ships the command that sets a
version, so the project declares which one it is and
[releasetools/cli](https://github.com/releasetools/cli) runs it.

The tag's shape is not declared: the conventions settle it, and a key here
would let a repository contradict a rule that is already made.

The tag lands only on a commit that has passed on its own, after the merge,
rather than on the pull request's last green check. A rebase onto a branch that
moved is a tree neither side has tested.
