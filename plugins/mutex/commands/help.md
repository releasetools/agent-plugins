---
name: help
description: What the mutex plugin can do, and what it will not
argument-hint: ""
---

Tell the user this, in your own words but no longer, and run nothing:

- `/mutex:preflight` - can mutex reach its lock table here
- `/mutex:lock <id> [reason]` - take a lock, an hour by default
- `/mutex:status [id]` - what you hold, and who holds the rest
- `/mutex:renew <id> [seconds]` - extend one before it lapses
- `/mutex:unlock <id>` - hand it back

It never takes a lock unasked, and never breaks somebody else's: there is no
`--force`, and taking over a named lock means naming its owner. Starting or
stopping the pooled server, choosing profiles and deleting expired rows stay
yours to run - `mutex server start`, `mutex profile`, `mutex prune`.

A lock lasts an hour unless asked otherwise, and a warning arrives at ten
minutes and again at two.
