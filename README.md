# ReleaseTools agent plugins

The plugin marketplace for [ReleaseTools](https://github.com/releasetools),
serving Claude Code and Codex from one catalog each.

Add the marketplace once. Everything after that is installing plugins from it.

## Claude Code

```shell
claude plugin marketplace add releasetools/agent-plugins
claude plugin install mutex@release-tools
```

Both steps work as `/plugin marketplace add` and `/plugin install` inside a
session.

## Codex

```shell
codex plugin marketplace add releasetools/agent-plugins
codex plugin add mutex@release-tools
```

## Hermes and Antigravity

Both clone this repository and read `plugin.json` at the plugin root, so
neither needs a marketplace or a checkout of your own. `agy` takes every plugin
in `plugins/`; `hermes` takes the one the subdirectory names.

```shell
agy plugin install https://github.com/releasetools/agent-plugins
hermes plugins install releasetools/agent-plugins/plugins/release-notes
```

## What is published

| Plugin          | What it does                                                          |
| --------------- | --------------------------------------------------------------------- |
| `mutex`         | Guard a shared resource with a distributed lock, using the mutex CLI  |
| `release-notes` | Draft a release's changelog entry from the commits since the last tag |
| `release`       | Cut a release: prechecks, notes, bump, pull request, merge, tag       |

The plugins live here: `plugins/<name>/` is the source, not a copy of one, and
a merge to `main` is the release. See [AGENTS.md](./AGENTS.md) for how to change
one.

### mutex needs the mutex CLI

Installing the plugin installs no `mutex` command, and never supplies a
connection string. The CLI is a separate installation, and
`MUTEX_DATABASE_URL` is yours to set:

```shell
mise use --global "npm:@releasetools/mutex@1"
mutex version
```

Other installation routes are in the
[mutex README](https://github.com/releasetools/mutex#readme). Once the plugin is
installed, `/mutex:preflight` reports whether the lock table is reachable from
where you are, and says what is missing when it is not.

## Keeping it up to date

Claude Code:

```shell
claude plugin marketplace list      # which marketplaces are configured
claude plugin list                  # what is installed, and at which version
claude plugin marketplace update release-tools
claude plugin update mutex@release-tools
```

Codex:

```shell
codex plugin marketplace list
codex plugin list
codex plugin marketplace upgrade    # refresh the marketplace snapshot first
codex plugin add mutex@release-tools # then install the version it now offers
```

Codex reads a snapshot of this repository, so a plugin update arrives only after
the marketplace itself is refreshed.

## Removing it

```shell
claude plugin uninstall mutex@release-tools
claude plugin marketplace remove release-tools
```

```shell
codex plugin remove mutex@release-tools
codex plugin marketplace remove release-tools
```

## Which clients this is tested with

Every change here is validated by installing every published plugin with both
clients, at the versions pinned in
[`.github/workflows/validate.yml`](./.github/workflows/validate.yml) - currently
Claude Code 2.1.235 and Codex 0.147.0. Newer clients are expected to work; those
are the ones something checked.
