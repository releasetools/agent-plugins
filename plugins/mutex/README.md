# mutex, as an agent plugin

Guard a shared resource with a distributed lock, so that one deploy, migration
or staging environment has a single holder at a time. The lock lives in a
PostgreSQL table that the [mutex CLI](https://github.com/releasetools/mutex) and
the `releasetools/mutex` GitHub Action also use, so a lock taken here blocks CI
too, and one taken by CI blocks the agent.

## Install

Add the marketplace once, then install the plugin.

Claude Code:

```shell
claude plugin marketplace add releasetools/agent-plugins
claude plugin install mutex@release-tools
```

Codex:

```shell
codex plugin marketplace add releasetools/agent-plugins
codex plugin add mutex@release-tools
```

Hermes and Antigravity clone this repository and read `plugin.json`, so they
install from GitHub with no marketplace to add:

```shell
hermes plugins install releasetools/agent-plugins/plugins/mutex
agy plugin install https://github.com/releasetools/agent-plugins
```

`agy` takes every plugin in the repository. `hermes` takes the one its
subdirectory names.

## What it needs

This plugin runs the `mutex` command; it does not contain it, and installing the
plugin installs nothing else. Nor does it supply a connection string: the lock
table's `MUTEX_DATABASE_URL` is yours to set, and the plugin never reads its
value or repeats it back.

```shell
mise use --global node@24 \
  'npm:@releasetools/mutex[allow_low_downloads=true]@1'
mutex version
```

Other installation routes, profiles that keep the connection warm, and
everything `MUTEX_DATABASE_URL` accepts are in the
[mutex README](https://github.com/releasetools/mutex#readme). `/mutex:preflight`
answers whether the table is reachable from where you are, and says what is
missing when it is not.

## Commands

| Command                         |                                                          |
| ------------------------------- | -------------------------------------------------------- |
| `/mutex:preflight`              | Can mutex reach its lock table here, and if not, why     |
| `/mutex:lock <id> [reason]`     | Take a lock, an hour by default                          |
| `/mutex:status [id]`            | Who holds a lock, and what this session holds            |
| `/mutex:renew <id> [seconds]`   | Extend a lock before it lapses                           |
| `/mutex:unlock <id>`            | Hand it back                                             |
| `/mutex:callsign <kind> [args]` | The lock id for a resource, derived rather than composed |
| `/mutex:help`                   | What the plugin does, and what it will not               |

An hour rather than the CLI's minute, because a conversation does not know how
long it will take, and a lease that lapses mid-conversation hands the resource
to somebody else while the work is still going on.

Two skills ride along: `mutex`, the judgment around a lock being taken, and
`naming`, which decides which lock an operation takes and what it is called.
`/mutex:callsign` derives the id from the resource, so every agent computes the
same one.

## What it will not do

It takes a lock when you ask for one, hands it back when the work is done, and
speaks up before the lease runs out. It never volunteers a lock, never breaks
somebody else's - taking over a named lock means naming its owner, and there is
no `--force` - and never runs `mutex server`, `mutex profile` or `mutex prune`
on your behalf. Starting a server, choosing a profile and deleting rows stay
yours to run.

## Knowing when the lock runs out

Locks are taken under a name that says who holds them - the agent, the host and
the session, as in `claude@workstation:22ca1fea-…` - so `mutex list` names the
conversation rather than a random string, and one session cannot release
another's lock.

Three variables change that name, and the first is the one that matters:

| Variable           |                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MUTEX_SESSION_ID` | Names this session, for an agent that publishes no id of its own. Without one, every session on the machine shares a name and can release the others' locks |
| `MUTEX_AGENT_NAME` | Renames the agent half, for an agent this plugin does not recognise                                                                                         |
| `MUTEX_OWNER`      | Replaces the whole name. The CLI's own variable, and it wins over both of the above                                                                         |

`/mutex:preflight` prints the name locks will be taken under, and says when it
is one every session on the machine shares.

What was taken is written to
`${XDG_STATE_HOME:-$HOME/.local/state}/releasetools-mutex/agent-locks.json`, and
a `UserPromptSubmit` hook reads it between turns: it asks the agent to check with
you ten minutes before a lock lapses, again at two, and says so once when one
has expired. No database round trip, and nothing to wire up. A deadline that has
to be asked about is a deadline nobody sees.

## License

Apache-2.0. See [LICENSE](./LICENSE).
