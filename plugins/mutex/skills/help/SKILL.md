---
name: help
description: What the mutex plugin can do, and what it will not
argument-hint: ""
---

Tell the user this, in your own words but no longer, and run nothing. Name
each entry the way their client invokes it: `/mutex:lock` in Claude Code,
`$mutex:lock` in Codex.

- `/mutex:preflight` - can mutex reach its lock table here. It runs only when
  called by name
- `/mutex:callsign <kind> [args...]` - derive a resource's lock id, the same on every machine
- `/mutex:lock <id> [reason]` - take a lock, an hour by default
- `/mutex:status [id]` - what you hold, and who holds the rest
- `/mutex:renew <id> [seconds]` - extend one before it lapses
- `/mutex:unlock <id>` - hand it back
- `/mutex:mutex` - the judgment around a lock. Asking in plain words, such as
  "lock staging while I run this migration", reaches it
- `/mutex:naming` - which lock an operation takes, and what it is called

It never takes a lock unasked, and never breaks somebody else's: there is no
`--force`, and taking over a named lock means naming its owner. Starting or
stopping the pooled server, choosing profiles and deleting expired rows stay
yours to run: `mutex server start`, `mutex profile`, `mutex prune`.

A lock lasts an hour unless asked otherwise, and a warning arrives at ten
minutes and again at two.
