---
name: naming
description: >
  Decide which lock an operation takes and what that lock is called, before
  any lock exists. Use when the user asks to name a lock, wants the lock id
  for a resource, asks which lock an operation needs or whether it needs one
  at all, or asks what something would be called - an issue, a PR, a branch,
  an environment - before locking a shared resource. Triggers on: name a
  lock, lock id, which lock, what would this be called, before locking a
  shared resource. Taking, renewing and releasing locks belongs to the mutex
  skill, not here.
---

# naming: one resource, one id

An advisory lock only excludes callers who ask for the same id. Two agents
that name one resource two ways exclude nobody, and two resources that share
a name block each other for no reason. Both failures are silent - so ids are
derived from the resource by rules every agent shares, and this skill carries
the judgment the derivation cannot: which operations take a lock at all.

## The grammar

```
<domain>/<segment>/<segment>...   segments match [a-z0-9._-]+, joined by /
255 characters or fewer; after pkg/npm/ a segment may open with @
```

Whatever id the platform hands out is used as given: lowercased, dashes kept,
otherwise unchanged. Issue and PR numbers unpadded, branch names with their
slashes, Notion UUIDs as printed - and never a title, which drifts.

## The domains

| Domain      | Covers                                               |
| ----------- | ---------------------------------------------------- |
| `gh/`       | GitHub: issues, PRs, branches, releases, admin, wiki |
| `glab/`     | GitLab: issues, MRs, branches, releases, admin, wiki |
| `notion/`   | Notion pages and databases, by UUID                  |
| `doc/`      | Document collections: `doc/rfc/0017`                 |
| `env/`      | Shared deploy targets: staging, prod                 |
| `db/`       | Databases: migrations, shared test databases         |
| `pkg/`      | Package publishing: npm, brew, docker                |
| `dns/`      | DNS zones                                            |
| `tf/`       | Terraform workspaces                                 |
| `host/`     | Machine-scoped: ports, simulators, devices           |
| `role/`     | Fleet singletons: one holder at a time, renewed      |
| `cron/`     | Scheduled jobs that must not overlap                 |
| `announce/` | Outbound announcements, to dedupe sends              |
| `secret/`   | Secret rotation                                      |

## Which operations lock

- An issue is one lock, `.../issue/<n>`, for any read-modify-write: edits,
  labels, closing, splitting, claiming. Appends take none - comments and
  reactions do not race.
- A PR is one lock, `.../pr/<n>`, for updating and reviewing alike, on
  purpose: a review of a branch being rewritten wastes both sides.
- Shared branches lock: pushes to protected or integration branches, rebases
  of stacked PRs, history rewrites. An agent's own namespaced branch and a
  worktree never lock - the remote is the shared resource, the laptop is not.
- A merge takes the branch lock and then the PR lock - sorted order of their
  ids, released in reverse - and never more than two locks. Anything needing
  more takes one coarser lock, such as `.../release`.
- When the guarded work is a single command - a deploy, a migration, a
  publish - wrap it, `mutex lock <id> -e 3600 -- <command>`, so the lock is
  held for exactly as long as the command runs and is released on every exit
  path, including a crash.

Reads never lock, and neither does anything the platform already makes
atomic.

## The leases

| Class                   | Examples                              | Lease         |
| ----------------------- | ------------------------------------- | ------------- |
| Quick read-modify-write | issue edit, label change, self-assign | 60-300s       |
| Conversation-length     | PR review, editing session            | 3600s         |
| Wrapped command         | deploy, migration, publish            | held by mutex |
| Background singleton    | reconciler, sweeper                   | 300s, renewed |

## Well-known ids

The ids derivation cannot produce, agreed instead: `env/staging` and
`env/prod`. A new one earns its place by a PR to this file, which is how
every agent learns it at once.

## Getting the id

Run `/mutex:name` - `name pr 98`, `name env staging`, `name check <id>` -
and use exactly what it prints. Never compose an id by hand: the helper is
the naming rule, and an id typed from memory is how two agents stop
excluding each other.
