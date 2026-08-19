# mutex reference

The mechanics behind [SKILL.md](./SKILL.md): where the helper is, what the CLI
takes, and what each failure means. Read it when something does not go as
expected - the skill covers the decisions, this covers the details.

## Finding the helper

`agent-lock.mjs` sits next to this file, inside the plugin.

- **Claude Code** substitutes `${CLAUDE_PLUGIN_ROOT}`, so the commands invoke
  `node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/agent-lock.mjs"` and nothing has to
  be searched for.
- **Everywhere else** it is `agent-lock.mjs` in the same directory as this
  file - the skill directory the agent loaded, which is
  `~/.hermes/skills/devops/mutex/`, `~/.gemini/skills/mutex/`, or a plugin
  cache under `~/.codex/plugins/`.
- A globally installed CLI carries a copy at
  `$(npm root -g)/@releasetools/mutex/skills/mutex/agent-lock.mjs`.

Without it, the plain CLI below does the same work - pass `--owner` explicitly
and keep using the same value - but nothing is recorded, so no warning arrives
before the lock lapses. Say that rather than letting the deadline go
unwatched.

## The helper

| Command             |                                                            |
| ------------------- | ---------------------------------------------------------- |
| `preflight`         | Can mutex reach the table here, and if not, whose fix      |
| `preflight --grant` | The same, and adds the permission rules to Claude Code     |
| `lock <id>`         | Take a lock and record it: an hour, waiting 30s            |
| `renew <id>`        | Extend one this session holds                              |
| `unlock <id>`       | Hand it back under the name it was taken with              |
| `status [id]`       | A table of what you hold; `--all` adds everybody else's    |
| `show`              | What was written down locally, without asking the table    |
| `forget <id>`       | Drop a local record without touching the lock              |
| `statusline`        | Optional: one line for a status line the user has wired up |
| `nudge`             | The prompt hook that warns before a lock lapses            |

Options: `--reason`, `--expiration <seconds>`, `--wait <seconds>`, `--try`,
`--owner <name>`, `--profile <name>`, `--grant`, `--json`, `--no-color`.

`--grant` appends `Bash(mutex:*)` and the helper's own invocation to
`permissions.allow` in `~/.claude/settings.json`, so neither the skill nor a
hand-run command stops to ask. It only ever appends, refuses a settings file it
cannot parse, and is passed by `/mutex:preflight` alone - never by this skill.

## The CLI underneath

| Command                                 |                                              |
| --------------------------------------- | -------------------------------------------- |
| `mutex lock <id>`                       | Acquire a lock, waiting up to `--max-wait`   |
| `mutex lock <id> -- <program>`          | Acquire it, run the program, release it      |
| `mutex try-lock <id>`                   | Acquire it in a single attempt               |
| `mutex unlock <id>`                     | Release it                                   |
| `mutex renew <id>`                      | Extend a lock you already hold               |
| `mutex status <id>`                     | Show who holds it                            |
| `mutex list`                            | List locks, expired ones included            |
| `mutex prune`                           | Delete locks that have already expired       |
| `mutex profile [name]`                  | List/set the default - **the user's to run** |
| `mutex server start\|run\|status\|stop` | The pooled server - **the user's to run**    |
| `mutex version`                         | Print the version                            |

Options worth knowing: `-r/--reason`, `-e/--expiration <seconds>` (default 60,
3600 on `renew`), `-w/--max-wait <seconds>` (default `-1`, meaning as long as
the lease itself, so with `-e 3600` it waits an hour - always set it when
running a command an agent has to come back from), `-i/--poll-interval`,
`-o/--owner`, `-p/--profile`, `--json`, `-q/--quiet`, `--verbose`. `try-lock`
takes no waiting options, because it does not wait.

## Exit codes

| Code  |                                                 |
| ----- | ----------------------------------------------- |
| `0`   | Success. For `status`, the lock is held         |
| `1`   | Error                                           |
| `2`   | Usage error                                     |
| `3`   | No usable connection string                     |
| `4`   | Not acquired, or not held                       |
| `5`   | Another owner holds the lock, and was not named |
| `126` | The wrapped program exists but could not be run |
| `127` | The wrapped program was not found               |

While wrapping a program, its exit status is returned instead.

## How it reaches the database

A **server profile** means a local mutex server holds the connection pool and
the connection string; the CLI reaches it over local TCP and needs no secret of
its own. A **direct profile**, or no profiles file at all, means each command
opens PostgreSQL itself and needs `$MUTEX_DATABASE_URL` in its own environment.
The two never fall back to each other, which is why the preflight decides by
running a command rather than by reading configuration.

mutex creates its `releasetools_mutex` table on first use, so the first read
may create an empty one.

## What the local record covers

Every session on the machine writes to one file, on purpose: a lock another
agent or terminal took is just as much in the way, and worth seeing. What it
changes is what you may do about it - a lock this session did not take can be
reported but not extended or released, since the owner will not match.

## Who the lock belongs to

The owner is the agent, the host and the session:
`claude@workstation:22ca1fea-a521-…`, from whichever session id the agent
publishes. `$MUTEX_OWNER` overrides it. It is derived, not generated, so it is
the same name every time this session asks - which is what lets a lock be
released after its local record is gone, and what stops one session from
releasing another's.

Where nothing in the environment names a session the owner is the agent and
host alone, and every session on that machine shares it. `/mutex:preflight`
says so when that is the case.

Only a named lock is protected; an unowned one is open to anyone. The Action
takes unowned locks unless a workflow sets `owner`.

## When something goes wrong

| What you see                                              | What it means                          | What to do                                                                                               |
| --------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `no connection string: MUTEX_DATABASE_URL is not set`     | Direct access with no secret           | Ask the user to export it for the command. Never pass it as an argument                                  |
| `cannot reach mutex server at ...`                        | Server profile, server not running     | Ask the user to run `mutex server start` where `$MUTEX_DATABASE_URL` is visible                          |
| TLS handshake errors, or a certificate complaint          | The connection's TLS settings          | mutex names the setting behind it. A profile's `ssl_negotiation = "direct"` needs PostgreSQL 17 or newer |
| `profile 'x' is not defined`                              | `-p` named something that is not there | Drop `-p`, or ask the user which profiles they have                                                      |
| `'x' is held by 'alice'; this call is unowned`            | Ownership guard, working as intended   | Report it. Only pass `--owner alice` if the user says to break it                                        |
| `Could not acquire 'x': contended`                        | Somebody else has it                   | Report the holder and their expiry; ask whether to wait                                                  |
| `'x' expired at ...; it may already have been taken over` | The renewal was too late               | Say the guard has lapsed; check `mutex status x` before taking it again                                  |
| `command not found: mutex`                                | CLI not installed                      | `npm install --global @releasetools/mutex@1`, Node.js 24 or newer                                        |

Full documentation: <https://github.com/releasetools/mutex#readme>
