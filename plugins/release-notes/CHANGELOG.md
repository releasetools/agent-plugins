# release-notes

Newest release first. Each says what changed, and the choices behind it.

Everything up to 0.3.0 was read back out of the commits, because the plugin
shipped three releases before it kept a changelog.

## 0.3.1 - 2026-09-18

The plugin carries this changelog. Nothing about running it changed: the
entries below were reconstructed so that somebody on an older version can see
what they are missing, and so that every release from here on has to say.

## 0.3.0 - 2026-09-11

`--path <dir>` drafts one subtree's changelog instead of the whole
repository's. The commit range covers only what touched that directory, the
entry lands in `<dir>/CHANGELOG.md`, and the scratch file is that subtree's
own, so a subtree draft and a repository draft can be open at once without
overwriting each other. Pass `--since` with it, since a subtree is usually
versioned on its own rather than tagged.

Before this a monorepo of independently versioned plugins had no way in:
`commits` walked the whole history, `write` joined `CHANGELOG.md` onto the
repository root, and `git describe` answered for a repository that may carry
no tags at all.

### Choices

A repository can keep both kinds of changelog, one per released thing and one
for itself. They are drafted separately and nothing reconciles them, so the
repository's entry can summarise what the subtree entries said, or say
something none of them did.

## 0.2.1 - 2026-09-11

The marketplace answers to `release-tools`, so installing is
`claude plugin install release-notes@release-tools` or
`codex plugin add release-notes@release-tools`.

## 0.2.0 - 2026-09-11

Hermes and Antigravity install the plugin from the repository.
`plugins/release-notes/plugin.json` is the portable manifest both read, so
`agy plugin install https://github.com/releasetools/agent-plugins` registers
the plugin through the host's own install, update and uninstall.

## 0.1.0 - 2026-09-10

The first release: draft a version's changelog entry from the commits since
the last tag, ruling on each commit before a word of the entry is written.

- `/release-notes:draft` reads every commit in the range against its own diff,
  and shows the ruling table before writing anything.
- One test decides each row: can a person running the software observe it? A
  refactor, a new test, a dependency bump that changes no behaviour is not an
  entry, whatever it cost to build. The ruling is per commit because a model
  asked for release notes writes them well and leaves changes out.
- The table carries a discrepancy column for where a commit message and its
  diff disagree, so a commit that says "fix typo" and moves a default is
  caught.
- `agent-notes.mjs` is the deterministic half: `commits` for the range,
  `evidence <sha>` for one commit's message, stat, file list and patch, and
  `write <version>` to put the entry in `CHANGELOG.md` under a dated heading
  above every older release.
- `write` leaves the same bytes in a scratch file, so what is published and
  what is committed cannot differ by a stray blank line.
