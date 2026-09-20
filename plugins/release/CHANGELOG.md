# release

Newest release first. Each says what changed, and the choices behind it.

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
