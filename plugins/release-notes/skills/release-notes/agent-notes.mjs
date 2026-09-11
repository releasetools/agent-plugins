/*
 * Copyright (c) 2025-2026 Mihai Bojin
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

/**
 * The deterministic half of drafting release notes.
 *
 * Judgment is the model's: which commits a reader can observe, what the entry
 * says, which category it belongs under. Four things around that judgment
 * cannot be left to reasoning, and they are what this script does.
 *
 * - **Evidence arrives one commit at a time.** The ruling is per commit, so
 *   the evidence is fetched per commit rather than as one log a model skims.
 *   A commit's own diff is what proves its message, and a message is only a
 *   claim.
 * - **A large diff is a stat, not a patch.** One commit here ran to 2,546
 *   lines across 17 files. Handing that to a model buys nothing the file list
 *   does not already say, so the patch stops at PATCH_LINE_LIMIT lines.
 * - **The entry lands in two files, in two shapes.** `CHANGELOG.md` takes a
 *   version heading above every older release and below the preamble;
 *   `RELEASE_EDITMSG` takes the same body with no heading, for whatever
 *   publishes the release. Inserting into the middle of a file is where an
 *   edit made by hand goes wrong.
 * - **A stale scratch file is a published mistake.** `commits` truncates it,
 *   so a run that dies halfway leaves an empty file rather than the previous
 *   release's body.
 *
 * Nothing here decides anything. It exits non-zero when it is asked to write
 * a version the changelog already carries, and otherwise prints what it read.
 */

/**
 * Where a patch stops being evidence and starts being volume, in lines.
 *
 * Past it the model gets the stat and the paths, which is what it would use
 * anyway: a 2,000 line diff is a rewrite, a generated file, or a first commit,
 * and none of the three is read line by line to decide whether a user can
 * observe it.
 */
export const PATCH_LINE_LIMIT = 500;

/**
 * Git's own name for a scratch file in `$GIT_DIR`, alongside `COMMIT_EDITMSG`,
 * `MERGE_MSG` and `TAG_EDITMSG`.
 *
 * It is resolved with `git rev-parse --git-path` rather than by joining
 * `.git/`, because in a linked worktree that resolves per worktree: two
 * worktrees preparing releases cannot overwrite each other. It also sits
 * outside the work tree, so nothing there can be committed by accident.
 */
const SCRATCH_FILENAME = "RELEASE_EDITMSG";

const CHANGELOG_FILENAME = "CHANGELOG.md";

const PREAMBLE = `# Changelog

The notable changes to this project, in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
`;

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

/** Semver, with the prerelease and build metadata a release candidate needs. */
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Record and field separators, so a commit body cannot break the parse. */
const RECORD = "\x1e";
const FIELD = "\x1f";

/** An error with a message meant for the user rather than a stack trace. */
class HelperError extends Error {
  constructor(message, code = EXIT_ERROR) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * Runs git, with room for a patch.
 *
 * `spawnSync` buffers a megabyte by default and reports the overflow as an
 * error rather than a truncation, which for a large first commit would look
 * like git failing.
 */
function git(args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new HelperError(`cannot run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFailure) {
      return null;
    }
    const said = (result.stderr ?? "").trim();
    throw new HelperError(said || `git ${args[0]} exited ${result.status}`);
  }
  return result.stdout;
}

export function repositoryRoot(cwd) {
  const root = git(["rev-parse", "--show-toplevel"], { cwd });
  return root.trim();
}

/** The scratch file's path, absolute in a main worktree and a linked one alike. */
export function scratchPath(cwd, subtree = null) {
  const name = subtree
    ? `${SCRATCH_FILENAME}-${subtree.replace(/\//g, "-")}`
    : SCRATCH_FILENAME;
  const found = git(
    ["rev-parse", "--path-format=absolute", "--git-path", name],
    { cwd },
  );
  return found.trim();
}

/**
 * The subtree a draft covers, repository-relative, or null for the whole
 * repository.
 *
 * A repository can keep one changelog per released thing and another for
 * itself. They are drafted separately and nothing reconciles them: a monorepo
 * entry can summarise what four plugin entries said, or say something none of
 * them did.
 */
export function readSubtree(value, cwd) {
  if (value === undefined) {
    return null;
  }
  const root = repositoryRoot(cwd);
  const absolute = path.resolve(cwd, value);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (relative === "") {
    return null;
  }
  if (relative.startsWith("..")) {
    throw new HelperError(
      `--path '${value}' is outside the repository`,
      EXIT_USAGE,
    );
  }
  if (!fs.existsSync(absolute)) {
    throw new HelperError(`--path '${value}' is not there`, EXIT_USAGE);
  }
  return relative;
}

/** The most recent tag reachable from HEAD, or null on a repository with none. */
export function previousTag(cwd) {
  const found = git(["describe", "--tags", "--abbrev=0"], {
    cwd,
    allowFailure: true,
  });
  const tag = found?.trim();
  return tag ? tag : null;
}

/**
 * Every commit in the range, oldest first, with the size of what it touched.
 *
 * A merge commit carries no diff of its own, so it lists no files. Under a
 * merge workflow its body is usually the pull request description, which is
 * why it is listed rather than filtered out.
 */
export function commitsInRange(cwd, range, subtree = null) {
  const log = git(
    [
      "log",
      "--reverse",
      `--format=${RECORD}%h${FIELD}%p${FIELD}%s`,
      "--numstat",
      range,
      ...(subtree ? ["--", subtree] : []),
    ],
    { cwd },
  );

  const commits = [];
  for (const record of log.split(RECORD)) {
    if (record.trim() === "") {
      continue;
    }
    const lines = record.split("\n");
    const [sha, parents, subject] = lines[0].split(FIELD);

    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of lines.slice(1)) {
      if (line.trim() === "") {
        continue;
      }
      const [added, removed] = line.split("\t");
      files += 1;
      // A binary file counts as touched and contributes no lines.
      insertions += Number.parseInt(added, 10) || 0;
      deletions += Number.parseInt(removed, 10) || 0;
    }

    commits.push({
      sha,
      subject,
      merge: parents.trim().split(/\s+/).length > 1,
      files,
      insertions,
      deletions,
    });
  }
  return commits;
}

/**
 * One commit's evidence.
 *
 * The author is deliberately absent. Handles never belong in an entry, and the
 * cheapest way to keep one out is not to hand it over.
 */
export function evidenceFor(cwd, sha) {
  const header = git(
    ["show", "--no-patch", `--format=%H${FIELD}%p${FIELD}%s${FIELD}%b`, sha],
    { cwd },
  );
  const [full, parents, subject, ...rest] = header.split(FIELD);
  const merge = parents.trim().split(/\s+/).length > 1;

  const stat = git(["show", "--stat", "--format=", "--no-color", sha], { cwd });
  const names = git(["show", "--name-only", "--format=", sha], { cwd });
  const patch = git(["show", "--patch", "--format=", "--no-color", sha], {
    cwd,
  });

  const lines = patch === "" ? 0 : patch.trimEnd().split("\n").length;
  const tooLong = lines > PATCH_LINE_LIMIT;

  return {
    sha: full.trim(),
    subject,
    body: rest.join(FIELD).trim(),
    merge,
    stat: stat.trim(),
    files: names
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
    patch: tooLong ? null : patch,
    patchOmitted: tooLong ? { lines, limit: PATCH_LINE_LIMIT } : null,
  };
}

/**
 * The pull requests a commit landed through, or null when the lookup failed.
 *
 * Worth a call under a merge workflow, where the pull request body is context
 * the commit does not carry. Under squash merges the commit body on the head
 * branch usually is the pull request body, so this earns nothing and costs a
 * round trip per commit.
 */
export function pullRequestsFor(cwd, sha) {
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/{owner}/{repo}/commits/${sha}/pulls`,
      "--jq",
      "[.[] | {number, title, body, headRef: .head.ref}]",
    ],
    { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    const said = (result.stderr ?? "").trim() || result.error?.message;
    return { pullRequests: null, why: said || "gh could not be run" };
  }
  try {
    return { pullRequests: JSON.parse(result.stdout), why: null };
  } catch (error) {
    return { pullRequests: null, why: `gh printed no JSON: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// The changelog
// ---------------------------------------------------------------------------

/** Strips a leading `v` and refuses anything that is not a version. */
export function readVersion(argument) {
  const version = argument.startsWith("v") ? argument.slice(1) : argument;
  if (!VERSION.test(version)) {
    throw new HelperError(`'${argument}' is not a version`, EXIT_USAGE);
  }
  return version;
}

/**
 * The versions a changelog already carries.
 *
 * A heading is `## 0.2.0` or `## 0.2.0 - 2026-09-11`, matched on the whole
 * line, so a version that is a prefix of another is not mistaken for it.
 */
export function changelogVersions(text) {
  const versions = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("## ")) {
      continue;
    }
    versions.push(
      line
        .slice(3)
        .replace(/\s+-.*$/, "")
        .trim(),
    );
  }
  return versions;
}

/** Today, where the person releasing is, rather than in UTC. */
export function today(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Puts a version's section above every older one and below the preamble.
 *
 * Newest first is what Keep a Changelog asks for and what a reader coming from
 * the previous version expects to find at the top. The preamble is whatever
 * sits above the first `## `, so a file that opens with a title and a note
 * keeps both.
 */
export function insertSection(text, heading, body) {
  const section = `## ${heading}\n\n${body.trim()}\n`;
  if (text === null) {
    return `${PREAMBLE}\n${section}`;
  }

  const lines = text.split("\n");
  let at = lines.findIndex((line) => line.startsWith("## "));
  if (at === -1) {
    at = lines.length;
  }

  const preamble = lines.slice(0, at);
  while (preamble.length > 0 && preamble[preamble.length - 1].trim() === "") {
    preamble.pop();
  }
  const rest = lines.slice(at);
  while (rest.length > 0 && rest[rest.length - 1].trim() === "") {
    rest.pop();
  }

  const above = preamble.length > 0 ? [...preamble, ""] : [];
  const below = rest.length > 0 ? ["", ...rest] : [];
  return `${[...above, ...section.trimEnd().split("\n"), ...below].join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function commandCommits(shared) {
  const { cwd, since, subtree, stdout } = shared;
  const tag = since ?? previousTag(cwd);
  const range = tag ? `${tag}..HEAD` : "HEAD";

  // Before anything is read, so a run that dies in the middle of the ruling
  // cannot leave the previous release's body for something else to publish.
  const scratch = scratchPath(cwd, subtree);
  fs.writeFileSync(scratch, "");

  write(
    stdout,
    JSON.stringify(
      {
        previousTag: tag,
        range,
        path: subtree,
        firstRelease: tag === null,
        changelog: path.join(
          repositoryRoot(cwd),
          subtree ?? "",
          CHANGELOG_FILENAME,
        ),
        scratchFile: scratch,
        scratchFileCleared: true,
        commits: commitsInRange(cwd, range, subtree),
      },
      null,
      2,
    ),
  );
  return EXIT_OK;
}

function commandEvidence(sha, shared) {
  const { cwd, pr, stdout, stderr } = shared;
  const evidence = evidenceFor(cwd, sha);

  if (pr) {
    const { pullRequests, why } = pullRequestsFor(cwd, evidence.sha);
    evidence.pullRequests = pullRequests;
    if (why) {
      write(stderr, `agent-notes: no pull request context: ${why}`);
    }
  }

  write(stdout, JSON.stringify(evidence, null, 2));
  return EXIT_OK;
}

function commandWrite(argument, shared) {
  const { cwd, subtree, stdout } = shared;
  const version = readVersion(argument);
  const root = repositoryRoot(cwd);

  const scratch = scratchPath(cwd, subtree);
  let body;
  try {
    body = fs.readFileSync(scratch, "utf8").trim();
  } catch {
    body = "";
  }
  if (body === "") {
    throw new HelperError(
      `${path.relative(root, scratch) || scratch} is empty. Write the entry's body to it, then run this again.`,
      EXIT_USAGE,
    );
  }

  const file = path.join(root, subtree ?? "", CHANGELOG_FILENAME);
  const shown = path.relative(root, file);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (existing !== null && changelogVersions(existing).includes(version)) {
    throw new HelperError(
      `${shown} already has a section for ${version}. Edit it there, or release the next version.`,
    );
  }

  const date = today();
  fs.writeFileSync(file, insertSection(existing, `${version} - ${date}`, body));
  // The same bytes in both places, so what is published and what is committed
  // cannot differ by a stray blank line.
  fs.writeFileSync(scratch, `${body}\n`);

  write(stdout, `${shown} now opens with ${version} - ${date}`);
  write(stdout, `The release body is in ${scratch}`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

function write(stream, text) {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function usage(invocation = "agent-notes.mjs") {
  return `Draft a release's changelog entry from the commits since the last tag.

  node ${invocation} commits [--since <tag>]
      What is in scope, as JSON: the previous tag, the range, and one row per
      commit. Clears the scratch file, so a run that fails leaves nothing to
      publish.

  node ${invocation} evidence <sha> [--pr]
      One commit's message, stat, file list and patch, as JSON. The patch is
      omitted past ${PATCH_LINE_LIMIT} lines and the stat says how long it was.
      --pr adds the pull requests it landed through, at one API call.

  node ${invocation} write <version>
      Reads the body from the scratch file, puts it in CHANGELOG.md under
      '## <version> - <date>' above every older release, and normalises the
      scratch file to the same bytes.

  --path <dir>
      On 'commits' and 'write': draft for one subtree instead of the whole
      repository. The range covers only commits touching it, the entry lands
      in <dir>/CHANGELOG.md, and the scratch file is its own, so a subtree
      draft and a repository draft can be in flight at once. A subtree is
      usually versioned on its own rather than tagged, so pass --since too.
`;
}

export function main(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const invocation = options.invocation ?? "agent-notes.mjs";

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        since: { type: "string" },
        path: { type: "string" },
        pr: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    write(stderr, `agent-notes: ${error.message}`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  const command = positionals[0] ?? "help";
  if (values.help || command === "help") {
    write(stdout, usage(invocation));
    return EXIT_OK;
  }

  const shared = {
    cwd: options.cwd ?? process.cwd(),
    since: values.since?.trim() || undefined,
    subtree: null,
    pr: values.pr === true,
    stdout,
    stderr,
  };

  try {
    shared.subtree = readSubtree(values.path?.trim() || undefined, shared.cwd);
    switch (command) {
      case "commits":
        return commandCommits(shared);
      case "evidence":
        if (!positionals[1]) {
          throw new HelperError("'evidence' needs a commit", EXIT_USAGE);
        }
        return commandEvidence(positionals[1], shared);
      case "write":
        if (!positionals[1]) {
          throw new HelperError("'write' needs a version", EXIT_USAGE);
        }
        return commandWrite(positionals[1], shared);
      default:
        write(
          stderr,
          `agent-notes: unknown command '${command}'\n\n${usage(invocation)}`,
        );
        return EXIT_USAGE;
    }
  } catch (error) {
    if (error instanceof HelperError) {
      write(stderr, `agent-notes: ${error.message}`);
      return error.code;
    }
    throw error;
  }
}

// Run directly, rather than imported by a test.
if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  process.exit(
    main(process.argv.slice(2), { invocation: process.argv[1] ?? undefined }),
  );
}
