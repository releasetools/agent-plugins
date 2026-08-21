# Working in this repository

This is where the plugins live. Editing one is an ordinary pull request: change
the files under `plugins/<name>/`, bump its version, and the merge is the
release. Nothing is copied in from anywhere else.

Two files are generated and must not be hand-edited: the catalogs.

## What is here

```text
plugins/<name>/                   A plugin. The source, not a copy of one
.claude-plugin/marketplace.json   Claude Code's catalog     (generated)
.agents/plugins/marketplace.json  Codex's catalog           (generated)
scripts/validate-plugin.mjs       One plugin's own layout
scripts/validate-marketplaces.mjs What holds between the two catalogs
scripts/sync-catalogs.mjs         Writes both catalogs from plugins/
scripts/check-version-bump.mjs    A changed plugin has to say so in its version
scripts/install-agent-skills.mjs  For the agents that read no manifest
scripts/catalogs.mjs              What all of those agree on
__tests__/                        Jest, run by `npm test`
```

## The two catalogs

Both name the marketplace `releasetools`, so `mutex@releasetools` means the same
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

**Bump the version in both manifests.** This is the rule with no second chance:
a client that already installed 0.1.0 compares versions to decide whether an
update exists, so shipping a fix under the same number means nobody receives it,
quietly, on every machine that already had it. `check-version-bump.mjs` reads
the diff against the base branch and fails the pull request when a plugin
changed and its version did not.

Semver is judged from what an agent sees: new commands or skills are a minor,
wording and fixes are a patch, and removing a command or changing what one does
is a major.

## The plugin and the CLI it drives

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

The `mutex` npm package carries a copy of `skills/` and `commands/`, fetched
from here when that release is built, so a global install can still seed Hermes,
Gemini and Antigravity - the agents that read no manifest and have no checkout.
`install-agent-skills.mjs` is what copies it, and it runs from either home.

## The website

[releasetools/website](https://github.com/releasetools/website) documents the
releasetools tools, and **the plugin is not on it**. `docs/mutex.md` describes
the CLI and the Action, and says nothing about this marketplace, the skill or
the slash commands.

So the first release that wants it there has a page to write: add
`docs/agent-plugins.md`, and list it under `Tools` in `sidebars.ts` next to
`mutex` and `cli`. `plugins/<name>/README.md` is the closest thing to a source -
it is what an agent host shows next to an install button.

After that, **a release that changes what a user sees needs a pull request there
too**: the install commands, what is in the slash menu, what the skill will and
will not do. It is a separate repository with its own deploy, so nothing here
updates it and nothing notices when it drifts.

## Before committing

```shell
npm run check
claude plugin validate --strict .
```

`.github/workflows/validate.yml` runs those, then installs every published
plugin with both clients out of the checkout. `main` requires the `validated`
job, which is one check name that stays true as the matrix grows.
