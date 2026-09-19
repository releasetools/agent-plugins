# release

Newest release first. Each says what changed, and the choices behind it.

## 0.1.0 - 2026-09-20

`/release:cut <version>` runs a release's steps in order: the prechecks, the
changelog entry, the version bump, the pull request and its checks, the merge,
the wait for the merged commit to go green, and the tag that publishes. It
stops at the first refusal and says what refused.

What each step needs is read from `.releasetools.yaml`: the branch a release is
cut from, the tag's shape, the workflow that has to be green, the workflow the
tag starts, the URL that must not already carry the version, and the command
the project declares for setting its version.

### Choices

The steps are commands, not a script. An agent that runs them reads what each
one printed and can say what went wrong; a script that wraps them turns a
failure into an exit code and a person into a reader of logs. That is the whole
reason this is a plugin rather than another subcommand.

Nothing here parses a manifest. Every ecosystem ships the command that sets a
version, so the project declares which one it is and
[releasetools/cli](https://github.com/releasetools/cli) runs it.

The tag lands only on a commit that has passed on its own, after the merge,
rather than on the pull request's last green check. A rebase onto a branch that
moved is a tree neither side has tested.
