---
name: preflight
description: >
  Add the Claude Code permission rules a release needs past the turn that
  started it, signing and pushing the release tag, to the user's or the
  project's settings.json, after showing every missing line and asking.
  Runs only when the user calls it by name.
disable-model-invocation: true
argument-hint: "[user | project]"
allowed-tools:
  - Bash(git rev-parse --show-toplevel)
  - Bash(jq:*)
  - Bash(mktemp)
  - Bash(diff -u:*)
  - Read
  - AskUserQuestion
---

# Add the release's permission rules to Claude Code's settings

[rules.json](rules.json) holds the rules a release needs once the turn that
started it has ended. The release skill's own `allowed-tools` lasts that one
turn, and a release spends several waiting on checks. Auto mode then refuses
to push the tag, since the push publishes, unless an allow rule covers it. The
deny rules refuse a forced push or a moved tag, which the allow rules'
trailing `*` would otherwise admit.

The rules cover the tag a release pushes to `origin`. A repository whose
release remote has another name needs its own push rule.

It configures Claude Code alone. In Codex, say so and stop.

An allow rule lets every Claude Code session the file covers run that
command without asking, not just a release. Write only the lines the user
approves in this run, and only after they approve them.

## 1. Which file

The argument is the scope. With none, ask which one, with this table:

| scope     | file                                                          | reaches                                                                                                     |
| --------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `user`    | `~/.claude/settings.json`                                     | every project on this machine                                                                               |
| `project` | `.claude/settings.json` under `git rev-parse --show-toplevel` | every machine that clones the repository once the file is committed, after each person trusts the workspace |

Any other argument: say that it takes `user` or `project`, and stop.

Below, `RULES` is the absolute path of `rules.json` beside this file and
`TARGET` the chosen file's absolute path. Write both out in every command,
since nothing carries from one command to the next.

## 2. What is missing

Where `TARGET` does not exist, every rule is missing. Otherwise:

```sh
jq --slurpfile want RULES '$want[0].permissions as $w | {allow: ($w.allow - (.permissions.allow // [])), deny: ($w.deny - (.permissions.deny // []))}' TARGET
```

When jq cannot read the file, stop: name the file and what jq said, and
change nothing. When both lists are empty, say the file already carries
every rule, and stop.

## 3. Ask

Write the file and every missing line in your reply, allow and deny apart,
then ask: add them, or stop. Say that the allow lines let any session that
file covers sign a `v` tag and push it to `origin` without asking, and that
the push starts whatever the repository publishes on a tag.

## 4. Write

Merge into a temporary file, show the change, then copy it over the target:

```sh
mktemp
jq --slurpfile want RULES '$want[0].permissions as $w | .permissions.allow = (.permissions.allow // []) + ($w.allow - (.permissions.allow // [])) | .permissions.deny = (.permissions.deny // []) + ($w.deny - (.permissions.deny // []))' TARGET > TEMP
diff -u TARGET TEMP
cp TEMP TARGET
```

`TEMP` is the path `mktemp` printed. For a `TARGET` that does not exist,
run the same program after `{} |` with `jq -n`, and `mkdir -p` the
directory before the copy.

Every other key keeps its value and its place, the rules already there keep
theirs, and each missing rule is appended once. jq rewrites the layout, with
two-space indentation. `cp` onto an existing file keeps that file's
permissions, which matters for a `~/.claude/settings.json` that holds
secrets in `env`.

Nothing here pre-approves the copy, so the client asks before it. Where it
refuses, print the `cp` command for the user to run with `!`, and stop.

## 5. Check and report

Run step 2 again: both lists are empty. Report the file and the lines it
gained. For `project`, the file is not committed: say that it reaches other
machines once it is merged through a pull request. Never commit it here.
