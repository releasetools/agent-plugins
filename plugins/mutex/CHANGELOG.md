# mutex

Newest release first. Each says what changed, and the choices behind it.

Everything up to 0.4.1 was read back out of the commits, because the plugin
shipped four releases before it kept a changelog.

## 0.4.2 - 2026-09-18

The plugin carries this changelog. Nothing about running it changed: the
entries below were reconstructed so that somebody on an older version can see
what they are missing, and so that every release from here on has to say.

## 0.4.1 - 2026-09-11

The marketplace answers to `release-tools`, so installing is
`claude plugin install mutex@release-tools` or
`codex plugin add mutex@release-tools`. The `ReleaseTools` handle from 0.3.2
no longer resolves.

## 0.4.0 - 2026-09-11

- Gemini is no longer recognised as a host, and `GEMINI_*_ID` is no longer
  read as a session id. A lock owner there is the agent and the machine alone,
  so every session on that machine shares one owner and can release the
  others' locks. Export `MUTEX_SESSION_ID` to give a session a name of its
  own. `/mutex:status` says when the session id is missing.
- Hermes and Antigravity install the plugin from the repository.
  `plugins/mutex/plugin.json` is the portable manifest both read, so
  `agy plugin install https://github.com/releasetools/agent-plugins`
  registers mutex through the host's own install, update and uninstall
  instead of a script copying files into a home directory.
- An Antigravity session gets a lock owner of its own. Its id is
  `ANTIGRAVITY_CONVERSATION_ID`, a spelling the owner rule did not accept, so
  sessions there had been sharing one name.

### Choices

- The portable manifest is generated from `.claude-plugin/plugin.json` and
  compared byte for byte, rather than maintained beside it. It carries only
  the fields the schema names, because an unknown field there fails
  validation instead of being ignored.
- Gemini CLI still installs by copy. Its extensions have to sit at the root of
  a repository or a release archive, and it has no notion of one inside a
  monorepo.

## 0.3.2 - 2026-08-23

The marketplace answers to `ReleaseTools` rather than `releasetools`, so
installing is `mutex@ReleaseTools`.

## 0.3.1 - 2026-08-21

`/mutex:callsign` stops short of naming a lock for an operation. Asked which
lock reviewing or deploying something takes, it points at the naming skill
rather than composing an id, because which lock an operation needs is a
judgment rather than a derivation.

## 0.3.0 - 2026-08-21

A `naming` skill decides which lock an operation takes and what that lock is
called, before any lock exists. It covers whether an operation needs a lock at
all, and what an issue, a pull request, a branch or an environment would be
called.

## 0.2.0 - 2026-08-21

`/mutex:callsign` derives a resource's lock id and prints it alone, so two
agents guarding the same thing compute the same id instead of inventing one
each. It takes a resource kind and its arguments, reads the repository from
`origin` or from `--repo owner/name`, and exits 2 naming the rule the input
broke.

## 0.1.0 - 2026-08-19

The first release: a distributed lock for a shared resource, held in a
PostgreSQL table that the mutex CLI and the `releasetools/mutex` GitHub Action
use as well, so a lock taken by an agent blocks CI and one taken by CI blocks
the agent.

- `/mutex:lock` takes a lock for the work that follows, `/mutex:unlock` hands
  it back, and `/mutex:renew` extends one before it expires.
- `/mutex:status` shows what you hold, or who holds a lock you name.
- `/mutex:preflight` answers whether the lock table is reachable from where
  you are, and says what is missing when it is not.
- A hook warns before a lock taken through the skill runs out.
- The plugin runs the `mutex` command and does not contain it. Installing the
  plugin installs nothing else, and `MUTEX_DATABASE_URL` is yours to set: the
  plugin never reads its value or repeats it back.
