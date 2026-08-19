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
claude plugin install mutex@releasetools
```

Codex:

```shell
codex plugin marketplace add releasetools/agent-plugins
codex plugin add mutex@releasetools
```

## What it needs

This plugin runs the `mutex` command; it does not contain it, and installing the
plugin installs nothing else. Nor does it supply a connection string: the lock
table's `MUTEX_DATABASE_URL` is yours to set, and the plugin never reads its
value or repeats it back.

```shell
mise use --global node@24 \
  'npm:@releasetools/mutex[allow_low_downloads=true]@latest'
mutex version
```

Other installation routes, profiles that keep the connection warm, and
everything `MUTEX_DATABASE_URL` accepts are in the
[mutex README](https://github.com/releasetools/mutex#readme). `/mutex:preflight`
answers whether the table is reachable from where you are, and says what is
missing when it is not.

## Commands

| Command                       |                                                      |
| ----------------------------- | ---------------------------------------------------- |
| `/mutex:preflight`            | Can mutex reach its lock table here, and if not, why |
| `/mutex:lock <id> [reason]`   | Take a lock, an hour by default                      |
| `/mutex:status [id]`          | Who holds a lock, and what this session holds        |
| `/mutex:renew <id> [seconds]` | Extend a lock before it lapses                       |
| `/mutex:unlock <id>`          | Hand it back                                         |
| `/mutex:help`                 | What the plugin does, and what it will not           |

An hour rather than the CLI's minute, because a conversation does not know how
long it will take, and a lease that lapses mid-conversation hands the resource
to somebody else while the work is still going on.

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

What was taken is written to
`${XDG_STATE_HOME:-$HOME/.local/state}/releasetools-mutex/agent-locks.json`, and
a `UserPromptSubmit` hook reads it between turns: it asks the agent to check with
you ten minutes before a lock lapses, again at two, and says so once when one
has expired. No database round trip, and nothing to wire up. A deadline that has
to be asked about is a deadline nobody sees.

## License

Apache-2.0. See [LICENSE](./LICENSE).
