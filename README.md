# releasetools agent plugins

The plugin marketplace for [releasetools](https://github.com/releasetools),
serving Claude Code and Codex from one catalog each.

Add the marketplace once. Everything after that is installing plugins from it.

## Claude Code

```shell
claude plugin marketplace add releasetools/agent-plugins
claude plugin install mutex@releasetools
```

Both steps work as `/plugin marketplace add` and `/plugin install` inside a
session.

## Codex

```shell
codex plugin marketplace add releasetools/agent-plugins
codex plugin add mutex@releasetools
```

## What is published

| Plugin  | What it does                                                         |
| ------- | -------------------------------------------------------------------- |
| `mutex` | Guard a shared resource with a distributed lock, using the mutex CLI |

Each plugin's own repository owns its source and decides its version;
`plugins/<name>/` here is a copy written by that repository's release and is
never edited by hand. See [AGENTS.md](./AGENTS.md) for how that works.

### mutex needs the mutex CLI

Installing the plugin installs no `mutex` command, and never supplies a
connection string. The CLI is a separate installation, and
`MUTEX_DATABASE_URL` is yours to set:

```shell
mise use --global "npm:@releasetools/mutex@latest"
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
claude plugin marketplace update releasetools
claude plugin update mutex@releasetools
```

Codex:

```shell
codex plugin marketplace list
codex plugin list
codex plugin marketplace upgrade    # refresh the marketplace snapshot first
codex plugin add mutex@releasetools # then install the version it now offers
```

Codex reads a snapshot of this repository, so a plugin update arrives only after
the marketplace itself is refreshed.

## Removing it

```shell
claude plugin uninstall mutex@releasetools
claude plugin marketplace remove releasetools
```

```shell
codex plugin remove mutex@releasetools
codex plugin marketplace remove releasetools
```

## Which clients this is tested with

Every change here is validated by installing every published plugin with both
clients, at the versions pinned in
[`.github/workflows/validate.yml`](./.github/workflows/validate.yml) - currently
Claude Code 2.1.235 and Codex 0.147.0. Newer clients are expected to work; those
are the ones something checked.
