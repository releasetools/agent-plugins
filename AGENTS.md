# Working in this repository

This is where the plugins live. Editing one is an ordinary pull request: change
the files under `plugins/<name>/`, bump its version, and the merge is the
release. Nothing is copied in from anywhere else.

Four kinds of file are generated and must not be hand-edited: the two
catalogs, each plugin's `plugin.json`, and
`plugins/release-notes/bin/releasetools-config.cjs`, which `npm run sync`
copies from the `@releasetools/config` version pinned in `package.json`. A
plugin installs as a clone of its marketplace and never runs `npm install`, so
that reader cannot be a dependency at runtime. Change it in
[releasetools/actions](https://github.com/releasetools/actions/tree/main/packages/config),
publish, bump the pin here, and run the sync.

## What is here

```text
plugins/<name>/                   A plugin. The source, not a copy of one
plugins/<name>/plugin.json        What every other agent reads  (generated)
.claude-plugin/marketplace.json   Claude Code's catalog     (generated)
.agents/plugins/marketplace.json  Codex's catalog           (generated)
scripts/validate-plugin.mjs       One plugin's own layout
scripts/validate-marketplaces.mjs What holds between the two catalogs
scripts/sync-catalogs.mjs         Writes both catalogs from plugins/
scripts/catalogs.mjs              What all of those agree on
.releasetools.yaml                What this repository holds, for every releasetools tool
__tests__/                        Jest, run by `npm test`
```

## The two catalogs

Both name the marketplace `release-tools`, so `mutex@release-tools` means the same
thing in either client. They describe the same plugins in the same order, and
each keeps its own client's schema:

- **Claude Code** takes a relative `source` of `./plugins/<name>`, the plugin's
  version, and the descriptive metadata it shows - description, author,
  homepage, licence, keywords. All of it comes from the plugin's
  `.claude-plugin/plugin.json`.
- **Codex** takes a local source object, `policy.installation: AVAILABLE`,
  `policy.authentication: ON_INSTALL`, and a category. It keeps its display
  metadata in the plugin's own manifest under `interface`, so the catalog entry
  carries only the category, which comes from there too.

Codex has no other kind of source. Its catalog resolves a plugin as a path
inside the marketplace it cloned, so a plugin cannot be a pointer at another
repository - which is why the plugins are here rather than referenced.

Neither client validates the other's file, so a marketplace whose two halves
disagree installs different things depending on which agent you asked. That is
what `validate-marketplaces.mjs` exists to catch, along with a source escaping
`plugins/`, a catalog version that is not the plugin's, a symlink or a secret in
a published tree, and a catalog somebody reformatted by hand.

## Changing a plugin

```shell
npm run check          # lint, typecheck, tests, then both validators
npm run sync           # rewrite the catalogs from plugins/
```

**Bump the version in both manifests, and write the entry.** This is the rule
with no second chance: a client that already installed 0.1.0 compares versions
to decide whether an update exists, so shipping a fix under the same number
means nobody receives it, quietly, on every machine that already had it. A fix
shipped with nothing written down loses the reasoning while somebody still
remembers it.

Two checks on every pull request enforce that, both from
[releasetools/actions](https://github.com/releasetools/actions):
`versions-guard` asks whether the version moved far enough for what changed,
and `changelog-guard` asks whether the plugin's `CHANGELOG.md` carries a
section for the version it now declares. Neither takes any configuration from
the workflow: `.releasetools.yaml` says that each directory under `plugins/`
is a project, where it keeps its version, and which changelog it owes.

How far the version has to move follows from what the changes say they are,
which is the [releasetools conventions](https://github.com/releasetools/conventions):
`typed-change` for the subject, `bump-from-type` for the arithmetic,
`semver-versions` for the number, `changelog-per-change` for the entry, and
`breaking-says-how` for what a break owes a reader. In agent terms a new
command or skill is a minor, wording and fixes are a patch, and removing a
command or changing what one does is a major.

Write the entry with `/release-notes:write`, from the plugin this repository
publishes. It reads the same `.releasetools.yaml`, so the note lands in the
changelog of the plugin the change is in, and it puts the same note in the
pull request as a `release-note` block for whatever collates the release.

## The other two agents

Claude Code and Codex resolve a plugin through a catalog. Hermes and
Antigravity clone this repository and read `plugin.json` at the plugin root, so
both install from GitHub with no copying and no checkout of your own:

```shell
hermes plugins install releasetools/agent-plugins/plugins/release-notes
agy plugin install https://github.com/releasetools/agent-plugins
```

`agy` reads `plugins/` as a bulk directory and takes every plugin in it.
`hermes` takes one, named by the subdirectory after `owner/repo`.

That `plugin.json` is the [Agent Plugins v1](https://agent-plugins.org) portable
format, and it carries only the fields that schema names: an unknown field is a
validation failure there rather than something ignored. It is generated from
`.claude-plugin/plugin.json` and compared byte for byte by the validator, for
the reason the catalogs are. A third place to write the version is a third
place for it to be wrong, and this one is read after a `git clone` rather than
through a catalog that would have caught it.

Check a change against the tools themselves rather than only against this
repository's validator. Both accept a directory:

```shell
hermes plugins doctor plugins/<name>
agy plugin validate plugins/<name>
```

Every agent this marketplace serves installs the plugin, and each unpacks it
under the plugin directory it manages, so `enable`, `update` and `uninstall`
mean something. Nothing here copies files into those directories behind a
tool's back, which is how a plugin nobody installed used to end up sitting in
one looking as though somebody had.

## mutex, and the CLI it drives

`plugins/mutex/skills/mutex/agent-lock.mjs` wraps the `mutex` CLI. It knows that
CLI's subcommands, flags, exit codes and the shape of its `--json`, so the two
move together even though their versions do not. `agent-lock.test.ts` answers
it with a shell stub, which proves the helper reads its own stub correctly and
nothing about the CLI.

`__tests__/contract.test.mjs` covers the other half: it runs the helper against
a published mutex and a real database, so a renamed flag or a changed exit code
upstream fails a build here. It needs both to run, and skips when it has
neither:

```shell
MUTEX_CONTRACT_DATABASE_URL=postgres://... npm test
```

CI runs it against `@releasetools/mutex@latest` - unpinned on purpose, because
the point is to find out what the plugin meets in the wild - on every pull
request and once a week, since the seam can break with nothing changing here.
Anything the helper uses that is newer than the published CLI is gated on a
version and skips with a note saying which, so it turns itself on the day that
version ships.

**Before opening a pull request that has the helper use something new from the
CLI - a subcommand, a flag, an exit code, a field in `--json` - check that a
released mutex has it.**

```shell
npm view @releasetools/mutex version
npx --yes @releasetools/mutex@latest list --help
```

If it does not, the change belongs in
[releasetools/mutex](https://github.com/releasetools/mutex) first, and the two
pull requests have to be **merged and released together**. The halves reach a
user from different places - the plugin from this marketplace, the CLI from npm

- so a plugin that needs an unreleased flag is a command that fails for everyone
  until the CLI ships.

That has already happened: `/mutex:status` began calling `mutex list --owner`
while the newest published CLI was 1.3.1, which answered
`'list' does not take --owner`. The two shipped together in the end - the plugin
at 0.1.0 and the CLI at 1.4.0 - so nobody ran into it. The contract suite covers
that flag now, but it would have found this after the fact; the rule above is
what stops it being written in the first place.

## release-notes, and the git it reads

`plugins/release-notes/bin/releasetools-config.cjs` is `@releasetools/config` from
`releasetools/actions`, carried here byte for byte: the guards there and this
plugin have to answer the same way about which project a change belongs to.
Change it there, then copy it.

`plugins/release-notes/bin/agent-notes.mjs` shells out to
`git`, and to `gh` only behind `--pr`. Neither is pinned and neither is
installed by the plugin, so there is no released version to check a change
against the way mutex needs one.

`agent-notes.test.ts` builds throwaway repositories with real commits, tags and
a merge rather than stubbing git. What is worth testing is the parsing: a
`--numstat` record split on the wrong byte, a merge counted as a change of its
own, a patch that should have been replaced by its length. A stub would answer
with whatever the parser expected.

The two files it writes are the contract anything downstream reads:
`CHANGELOG.md` at the repository root, and `RELEASE_EDITMSG` resolved with
`git rev-parse --path-format=absolute --git-path`, which puts it per worktree
and outside the work tree. Changing either name breaks callers that live in
other repositories and cannot be found from here.

## The website

[releasetools/website](https://github.com/releasetools/website) documents the
ReleaseTools tools, and both plugins are on it. `docs/mutex.md` carries an
`## Agent plugin` section covering the marketplace install commands, both
skills, and every entry in the slash menu, alongside the CLI and the Action.
`release-notes` has `docs/release-notes.md` to itself, since no CLI and no
Action sit behind it: the install commands for all four clients, the command
table, the two files it writes, and what it will not do. There is no
`docs/agent-plugins.md`, and a third page would only repeat them.

**A release that changes what a user sees needs a pull request there too**: the
install commands, what is in the slash menu, what the skill will and will not
do. It is a separate repository with its own deploy, so nothing here
updates it and nothing notices when it drifts.

## Before committing

```shell
npm run check
claude plugin validate --strict .
```

`.github/workflows/validate.yml` runs those, then installs every published
plugin with both clients out of the checkout. `main` requires the `validated`
job, which is one check name that stays true as the matrix grows.
