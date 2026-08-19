# Working in this repository

This is a catalog, not a codebase. Everything under `plugins/` is generated, and
so are both marketplace files. **Nothing in either is edited by hand.**

## What is here

```text
.claude-plugin/marketplace.json   Claude Code's catalog
.agents/plugins/marketplace.json  Codex's catalog
plugins/<name>/                   A published plugin, copied from its own repository
scripts/publish-plugin.mjs        Puts an assembled plugin into both catalogs
scripts/validate-marketplaces.mjs The invariants that hold between the two
scripts/catalogs.mjs              What both of those agree on
tests/                            node --test, no dependencies
```

There is no `package.json` and no lockfile, deliberately. The job that publishes
holds a token that can write to every consumer's plugin, and everything it can
execute is something an attacker would like to be able to execute - so it runs
Node's standard library and nothing else. `npm ci` never runs here.

## The two catalogs

Both name the marketplace `releasetools`, so `mutex@releasetools` means the same
thing in either client. They describe the same plugins in the same order, and
each keeps its own client's schema:

- **Claude Code** takes a relative `source` of `./plugins/<name>`, the plugin's
  version, and the descriptive metadata it shows - description, author,
  homepage, licence, keywords. All of it comes from
  `plugins/<name>/.claude-plugin/plugin.json`.
- **Codex** takes a local source object, `policy.installation: AVAILABLE`,
  `policy.authentication: ON_INSTALL`, and a category. It keeps its display
  metadata in the plugin's own manifest under `interface`, so the catalog entry
  carries only the category, which comes from there too.

Neither client validates the other's file, so a marketplace whose two halves
disagree installs different things depending on which agent you asked. That is
what `scripts/validate-marketplaces.mjs` exists to catch, along with a source
that escapes `plugins/`, a catalog version that is not the plugin's, a symlink
or a secret in a published tree, and a catalog somebody reformatted by hand.

Both files are written as two-space JSON with a trailing newline, and the
validator re-serialises them and compares the bytes. A generated file that a
formatter would rewrite shows up dirty in the next unrelated pull request, and
then gets committed by hand - which is how a generated catalog stops being
generated.

## How a plugin gets here

From its own repository's release, never from this one:

1. That repository assembles a standalone plugin directory - manifests,
   commands, hooks, skills, licence, README - in a job with no credentials, and
   validates it with both client CLIs.
2. A second job mints a GitHub App token scoped to this repository alone, checks
   out `main`, and runs `scripts/publish-plugin.mjs --plugin <dir>` with plain
   Node.
3. That job validates the staged marketplace, installs the plugin out of it with
   both clients, and publishes the whole tree with
   `releasetools/actions/signed-push` (`prune: true`), tagging the commit
   `<name>-v<version>`.

`signed-push` commits against the target HEAD it read, so two plugins publishing
at once means the loser fails rather than overwrites; re-running from the new
HEAD converges.

The publisher will not do three things: publish a version below the one already
there, change the contents of a version already published, or disturb any other
plugin's entry or position. The first two are what `--allow-republish` is for,
and it is meant to be typed by a person who has decided a release was wrong.
An ordinary mistake is corrected by bumping the plugin's version, because
somebody has already installed the old one.

## Before committing

```shell
node --test tests/*.test.mjs
node scripts/validate-marketplaces.mjs
claude plugin validate --strict .
```

The same three run in `.github/workflows/validate.yml`, which then installs
every published plugin with both clients - the only check that covers the path a
user actually takes. `main` requires it.

## Rolling back

Revert the generated commit and publish that complete tree through
`signed-push`. Do not move an existing `<name>-v<version>` tag: it is what
somebody installed.
