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
import { createRequire } from "node:module";
import os from "node:os";
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

/** The same idea for one change's note, drafted before there is a release. */
const NOTE_FILENAME = "NOTE_EDITMSG";

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

// ---------------------------------------------------------------------------
// What a change declares about itself
// ---------------------------------------------------------------------------

/**
 * A fenced block tagged `release-note`, which is where a note is declared.
 *
 * Text outside the block is never a note: a description is written for a
 * reviewer, and what a release publishes is the part somebody marked for
 * publishing.
 */
const NOTE_BLOCK =
  /^[ \t]*(`{3,}|~{3,})[ \t]*release-note[ \t]*\r?\n([\s\S]*?)\r?\n?^[ \t]*\1[ \t]*$/gm;

/** A Conventional Commits subject: type, optional scope, optional `!`. */
const SUBJECT = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;

/** Which changelog section each type's notes belong under, null for silent types. */
const SECTIONS = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  deprecate: "Deprecated",
  remove: "Removed",
  security: "Security",
  refactor: null,
  test: null,
  docs: null,
  build: null,
  ci: null,
  chore: null,
  style: null,
};

/**
 * The release note a description declares, if it declares one.
 *
 * `NONE` is an author saying a reader can observe nothing, which is an answer
 * and not a missing block. Two blocks are a change that needs splitting, and
 * are reported rather than merged.
 */
export function releaseNote(text) {
  const blocks = [...(text ?? "").matchAll(NOTE_BLOCK)].map((match) =>
    match[2]
      .replace(/^\s*\n/, "")
      .trimEnd()
      .trim(),
  );
  const first = blocks[0] ?? null;
  const none = first !== null && /^NONE$/.test(first);
  return {
    declared: first !== null,
    none,
    text: first === null || none ? null : first,
    blocks: blocks.length,
  };
}

/**
 * What the subject says the change is.
 *
 * The type decides the section, so a note declared in the block carries prose
 * only and nothing is declared in two places. A subject that follows no
 * convention leaves every field null, and the diff is all there is.
 */
export function declaredType(subject, body) {
  const match = SUBJECT.exec((subject ?? "").trim());
  const footer = /^BREAKING CHANGE:\s*(.*)$/m.exec(body ?? "");
  const type = match ? match[1].toLowerCase() : null;
  return {
    type,
    scope: match && match[2] ? match[2] : null,
    known: type !== null && Object.hasOwn(SECTIONS, type),
    section: type !== null ? (SECTIONS[type] ?? null) : null,
    breaking: Boolean(match && match[3]) || footer !== null,
    breakingSaysHow: footer !== null && footer[1].trim() !== "",
  };
}

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

/** Where one change's note is drafted, per worktree like the release body. */
export function notePath(cwd) {
  const found = git(
    ["rev-parse", "--path-format=absolute", "--git-path", NOTE_FILENAME],
    {
      cwd,
    },
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
  const body = rest.join(FIELD).trim();

  return {
    sha: full.trim(),
    subject,
    body,
    declares: declaredType(subject, body),
    note: releaseNote(body),
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
    const pullRequests = JSON.parse(result.stdout).map((pull) => ({
      ...pull,
      note: releaseNote(pull.body),
    }));
    return { pullRequests, why: null };
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
 * The date an entry carries: the commit date of `at`, or today.
 *
 * Today is right for a release being cut now and wrong for one written up
 * afterwards, which is what a subtree versioned on its own usually needs: a
 * plugin released in August and written up in September is dated August. A
 * date read off the commit cannot be mistyped, and cannot contradict the
 * history the entry describes.
 */
export function dateFor(cwd, at) {
  if (!at) {
    return today();
  }
  // %cs is the committer date as YYYY-MM-DD, in the timezone it was made in.
  const stamp = git(["log", "-1", "--format=%cs", at, "--"], {
    cwd,
    allowFailure: true,
  });
  if (stamp === null || stamp.trim() === "") {
    throw new HelperError(`--at '${at}' is not a commit`, EXIT_USAGE);
  }
  return stamp.trim();
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
// What the repository declares
// ---------------------------------------------------------------------------

/**
 * The declaration every releasetools tool reads.
 *
 * `releasetools-config.cjs` beside this file is @releasetools/config, byte for
 * byte, carried from releasetools/actions rather than reimplemented: the
 * guards there and this plugin have to give the same answer to which project a
 * change belongs to, or a note lands in the wrong changelog. A plugin installs
 * as a clone of its marketplace and never runs `npm install`, which is why it
 * is a file here rather than a dependency. Only the extension differs, because
 * this repository is ESM and the file is CommonJS.
 */
const {
  CONFIG_FILE: CONFIG_FILENAME,
  ConfigError,
  IGNORED,
  MANIFESTS,
  MISSPELLED,
  parseYaml,
  settingsFrom,
} = createRequire(import.meta.url)("./releasetools-config.cjs");

export { parseYaml };

/** What the repository declared, with the defaults the format names filled in. */
export function readConfig(cwd) {
  const root = repositoryRoot(cwd);
  let text;
  try {
    text = fs.readFileSync(path.join(root, CONFIG_FILENAME), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new HelperError(`cannot read ${CONFIG_FILENAME}: ${error.message}`);
    }
    if (fs.existsSync(path.join(root, MISSPELLED))) {
      throw new HelperError(
        `${MISSPELLED} is not read. The file is ${CONFIG_FILENAME}; rename it, or this ` +
          "writes to the changelog at the repository root.",
      );
    }
    return defaults(false);
  }

  let declared;
  try {
    declared = settingsFrom(text, CONFIG_FILENAME);
  } catch (error) {
    throw error instanceof ConfigError ? new HelperError(error.message) : error;
  }

  return {
    found: true,
    groups:
      declared.projects.length > 0
        ? declared.projects.map((group) => ({
            path: group.path,
            manifest: group.manifest ?? [],
            changelog: group.changelog ?? null,
            bump: group.bump ?? null,
          }))
        : defaults(true).groups,
    ignoreFiles: declared.ignoreFiles ?? IGNORED,
    caseSensitive: declared.caseSensitive,
    except: declared.except,
  };
}

function defaults(found) {
  return {
    found,
    groups: [{ path: ["./"], manifest: [], changelog: null }],
    ignoreFiles: IGNORED,
    caseSensitive: false,
    except: [],
  };
}

/**
 * The projects the declaration resolves to, in the repository as it stands.
 *
 * A directory two groups both reach belongs to the first, which is what the
 * format says and what lets a group naming one project sit above the group
 * that globs its neighbours.
 */
export function projectsIn(root, config) {
  const found = new Map();
  for (const group of config.groups) {
    for (const pattern of group.path) {
      for (const directory of expand(root, pattern)) {
        if (found.has(directory)) {
          continue;
        }
        const manifests = (
          group.manifest.length > 0 ? group.manifest : MANIFESTS
        ).filter((name) => fs.existsSync(path.join(root, directory, name)));
        found.set(directory, {
          path: directory,
          label: directory === "" ? path.basename(root) : directory,
          changelog: group.changelog,
          bump: group.bump ?? null,
          manifests,
        });
      }
    }
  }
  return [...found.values()].sort((one, other) =>
    one.path.localeCompare(other.path),
  );
}

/** One directory, or the directories a trailing `*` names. */
function expand(root, pattern) {
  const cleaned = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (cleaned === "" || cleaned === ".") {
    return [""];
  }
  if (!cleaned.includes("*")) {
    return fs.existsSync(path.join(root, cleaned)) ? [cleaned] : [];
  }
  const at = cleaned.lastIndexOf("/");
  const parent = at === -1 ? "" : cleaned.slice(0, at);
  const leaf = at === -1 ? cleaned : cleaned.slice(at + 1);
  if (leaf !== "*") {
    throw new HelperError(
      `${CONFIG_FILENAME}: '${pattern}' is a pattern this does not read`,
    );
  }
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, parent), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => (parent === "" ? entry.name : `${parent}/${entry.name}`));
}

/**
 * Which project a file belongs to: the deepest one that contains it.
 *
 * A repository that declares both itself and its packages means the package
 * for a file inside one, or every note would land in the repository's own
 * changelog as well.
 */
export function projectFor(projects, file) {
  let best = null;
  for (const project of projects) {
    if (
      project.path === "" ||
      file === project.path ||
      file.startsWith(`${project.path}/`)
    ) {
      if (best === null || project.path.length > best.path.length) {
        best = project;
      }
    }
  }
  return best;
}

/** Whether an edit is the project changing, or a release writing itself down. */
export function counts(file, project, config) {
  const relative =
    project.path === "" ? file : file.slice(project.path.length + 1);
  const owned = [
    ...project.manifests,
    ...(project.changelog ? [project.changelog] : []),
  ];
  if (owned.includes(relative)) {
    return false;
  }
  return !config.ignoreFiles.some((pattern) =>
    matches(relative, pattern, config.caseSensitive),
  );
}

/** A pattern matched against the end of a path, on segment boundaries. */
function matches(file, pattern, caseSensitive) {
  const fold = (value) => (caseSensitive ? value : value.toLowerCase());
  const target = fold(file).split("/");
  const wanted = fold(pattern).split("/");
  if (wanted[wanted.length - 1] === "**") {
    const prefix = wanted.slice(0, -1);
    return prefix.every((segment, index) => segment === target[index]);
  }
  if (wanted.length > target.length) {
    return false;
  }
  const tail = target.slice(target.length - wanted.length);
  return wanted.every((segment, index) => segmentMatches(tail[index], segment));
}

function segmentMatches(segment, pattern) {
  if (!pattern.includes("*")) {
    return segment === pattern;
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(segment);
}

/** The version a manifest declares, however that ecosystem writes it. */
export function versionIn(file, text) {
  if (file.endsWith(".json")) {
    const version = JSON.parse(text).version;
    if (typeof version !== "string") {
      throw new HelperError(`${file} declares no version`);
    }
    return version;
  }
  if (file.endsWith(".toml")) {
    // The version of the package this file is for, and not a dependency's,
    // so only the tables that name one count.
    const wanted = ["package", "project", "tool.poetry", "workspace.package"];
    for (const table of text.split(/^[ \t]*\[/m)) {
      const name = /^([^\]\n]+)\]/.exec(table);
      if (!name || !wanted.includes(name[1].trim())) {
        continue;
      }
      const version = /^[ \t]*version[ \t]*=[ \t]*["']([^"']+)["']/m.exec(
        table,
      );
      if (version) {
        return version[1];
      }
    }
    throw new HelperError(`${file} declares no version`);
  }
  if (file.endsWith(".yaml") || file.endsWith(".yml")) {
    const version = /^version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(text);
    if (!version) {
      throw new HelperError(`${file} declares no version`);
    }
    return version[1];
  }
  const only = text.trim();
  if (only === "" || only.includes("\n")) {
    throw new HelperError(
      `${file} is not a file holding a version and nothing else`,
    );
  }
  return only;
}

/** The next version after this one, for the part the changes imply. */
export function increment(version, part) {
  const [major, minor, patch] = version
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map(Number);
  if ([major, minor, patch].some((number) => Number.isNaN(number))) {
    return null;
  }
  // Under 0.y.z nothing is promised, so a break costs a minor rather than the
  // 1.0.0 nobody is ready to declare.
  const wanted = part === "major" && major === 0 ? "minor" : part;
  if (wanted === "major") {
    return `${major + 1}.0.0`;
  }
  if (wanted === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

/** The largest increment the types in a range imply, or null for none. */
export function requiredPart(commits) {
  let part = null;
  const rank = { patch: 1, minor: 2, major: 3 };
  for (const commit of commits) {
    const declared =
      commit.declares ?? declaredType(commit.subject, commit.body ?? "");
    let wanted = null;
    if (declared.breaking) {
      wanted = "major";
    } else if (declared.type === "feat" || declared.type === "deprecate") {
      wanted = "minor";
    } else if (["fix", "perf", "security"].includes(declared.type)) {
      wanted = "patch";
    } else if (declared.type === "remove") {
      wanted = "major";
    }
    if (wanted !== null && (part === null || rank[wanted] > rank[part])) {
      part = wanted;
    }
  }
  return part;
}

/** Keep a Changelog's order, so a section reads the same in every repository. */
const CATEGORIES = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
];

/** Whether a `## ` heading names this version, however it was written. */
function headingNames(line, version) {
  const text = line.slice(3).trim();
  const named = /^\[?v?([0-9][^\]\s]*)\]?/.exec(text);
  return named !== null && named[1] === version;
}

/**
 * Puts one entry in the section for a version, creating what is missing.
 *
 * A change writes its own entry, so the section it goes in is usually one an
 * earlier change already opened. Appending to the right `###` inside it is the
 * edit that goes wrong by hand, and doing it twice is the other one: an entry
 * already there is left alone rather than repeated.
 */
export function insertEntry(text, { version, date, section, entry }) {
  const body = entry.trim();
  const heading = `${version} - ${date}`;
  if (
    text === null ||
    !text
      .split("\n")
      .some((line) => line.startsWith("## ") && headingNames(line, version))
  ) {
    const opening = section ? `### ${section}\n\n${body}` : body;
    return { text: insertSection(text, heading, opening), added: true };
  }

  const lines = text.split("\n");
  const start = lines.findIndex(
    (line) => line.startsWith("## ") && headingNames(line, version),
  );
  let end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
  if (end === -1) {
    end = lines.length;
  }

  const inside = lines.slice(start + 1, end);
  if (inside.join("\n").includes(body)) {
    return { text, added: false };
  }

  if (section === null) {
    return {
      text: splice(lines, start, end, [...trimmed(inside), "", body]),
      added: true,
    };
  }

  const at = inside.findIndex((line) => line.trim() === `### ${section}`);
  if (at !== -1) {
    let until = inside.findIndex(
      (line, index) => index > at && line.startsWith("### "),
    );
    if (until === -1) {
      until = inside.length;
    }
    const under = trimmed(inside.slice(at, until));
    const rest = inside.slice(until);
    return {
      text: splice(lines, start, end, [
        ...inside.slice(0, at),
        ...under,
        "",
        body,
        "",
        ...trimmed(rest),
      ]),
      added: true,
    };
  }

  // A category nothing has written under yet, in the order Keep a Changelog
  // lists them rather than the order changes happened to arrive.
  const rank = CATEGORIES.indexOf(section);
  let before = inside.length;
  for (let index = 0; index < inside.length; index += 1) {
    const found = /^### (.+)$/.exec(inside[index].trim());
    const other = found ? CATEGORIES.indexOf(found[1]) : -1;
    if (other !== -1 && other > rank) {
      before = index;
      break;
    }
  }
  const above = trimmed(inside.slice(0, before));
  const below = trimmed(inside.slice(before));
  return {
    text: splice(lines, start, end, [
      ...(above.length > 0 ? [...above, ""] : []),
      `### ${section}`,
      "",
      body,
      ...(below.length > 0 ? ["", ...below] : []),
    ]),
    added: true,
  };
}

function trimmed(lines) {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1].trim() === "") {
    copy.pop();
  }
  while (copy.length > 0 && copy[0].trim() === "") {
    copy.shift();
  }
  return copy;
}

function splice(lines, start, end, inside) {
  const rest = lines.slice(end);
  const tail = rest.length > 0 ? ["", ...rest] : [""];
  return [...lines.slice(0, start + 1), "", ...inside, ...tail]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// One change
// ---------------------------------------------------------------------------

/** The branch this change is against, from the argument or from the remote. */
export function baseOf(cwd, given) {
  if (given) {
    return given;
  }
  const head = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
    cwd,
    allowFailure: true,
  });
  if (head) {
    return head.trim().replace("refs/remotes/", "");
  }
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (
      git(["rev-parse", "--verify", "--quiet", candidate], {
        cwd,
        allowFailure: true,
      })
    ) {
      return candidate;
    }
  }
  throw new HelperError(
    "no base branch found; name one with --base",
    EXIT_USAGE,
  );
}

/** Every file this branch touched, committed or not. */
export function changedFiles(cwd, forkPoint) {
  const committed = git(["diff", "--name-only", `${forkPoint}..HEAD`], { cwd });
  const working = git(["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
  });
  const files = new Set(
    committed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  for (const line of working.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    // XY PATH, or XY OLD -> NEW for a rename.
    const at = line.slice(3).split(" -> ");
    files.add(at[at.length - 1].trim().replace(/^"|"$/g, ""));
  }
  return [...files].sort();
}

/** The note this change already declares, in a commit on the branch. */
export function noteInRange(cwd, range) {
  const log = git(
    ["log", "--reverse", `--format=${RECORD}%h${FIELD}%s${FIELD}%b`, range],
    { cwd },
  );
  for (const record of log.split(RECORD)) {
    if (record.trim() === "") {
      continue;
    }
    const [sha, subject, ...rest] = record.split(FIELD);
    const note = releaseNote(rest.join(FIELD));
    if (note.declared) {
      return { ...note, source: `commit ${sha}`, subject };
    }
  }
  return null;
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
  const { cwd, pulls, stdout, stderr } = shared;
  const evidence = evidenceFor(cwd, sha);

  if (pulls) {
    const { pullRequests, why } = pullRequestsFor(cwd, evidence.sha);
    evidence.pullRequests = pullRequests;
    if (why) {
      write(stderr, `agent-notes: no pull request context: ${why}`);
    }
  }

  write(stdout, JSON.stringify(evidence, null, 2));
  return EXIT_OK;
}

/** Every commit on the branch, with what each declares about itself. */
export function changesIn(cwd, range) {
  const log = git(
    ["log", "--reverse", `--format=${RECORD}%h${FIELD}%s${FIELD}%b`, range],
    {
      cwd,
    },
  );
  const changes = [];
  for (const record of log.split(RECORD)) {
    if (record.trim() === "") {
      continue;
    }
    const [sha, subject, ...rest] = record.split(FIELD);
    const body = rest.join(FIELD).trim();
    changes.push({
      sha,
      subject,
      declares: declaredType(subject, body),
      note: releaseNote(body),
    });
  }
  return changes;
}

/**
 * What this branch changes, and which of the repository's projects it lands
 * in.
 *
 * The declaration decides both. A note written for a change in one package
 * that lands in another package's changelog is worse than no note, and the
 * only thing standing between those two outcomes is reading the file rather
 * than guessing from the path.
 */
function scope(shared) {
  const { cwd } = shared;
  const root = repositoryRoot(cwd);
  const config = readConfig(cwd);
  const against = baseOf(cwd, shared.base);
  const forkPoint = git(["merge-base", against, "HEAD"], { cwd }).trim();
  const range = `${forkPoint}..HEAD`;
  const changes = changesIn(cwd, range);
  const files = changedFiles(cwd, forkPoint);
  const all = projectsIn(root, config);
  const part = requiredPart(changes);

  const projects = all
    .map((project) => {
      const changed = files.filter(
        (file) =>
          projectFor(all, file) === project && counts(file, project, config),
      );
      const held = project.manifests[0] ?? null;
      let version = null;
      let unreadable = null;
      if (held) {
        try {
          version = versionIn(
            held,
            fs.readFileSync(path.join(root, project.path, held), "utf8"),
          );
        } catch (error) {
          unreadable = error.message;
        }
      }
      const released = version !== null && isReleased(cwd, project, version);
      return {
        path: project.path,
        label: project.label,
        // What sets this project's version, for whatever coordinates a
        // release. This never runs it.
        bump: project.bump ?? null,
        changelog: project.changelog
          ? path.join(root, project.path, project.changelog)
          : null,
        manifest: held,
        version,
        unreadable,
        released,
        // 48b: this never writes a manifest. It says what the types ask for,
        // and the version is somebody else's to move.
        asksFor:
          released && part !== null && version !== null
            ? increment(version, part)
            : null,
        changed,
      };
    })
    .filter((project) => project.changed.length > 0);

  return { root, config, against, forkPoint, range, changes, projects, part };
}

/** Whether a tag already names this version, in either shape the format allows. */
function isReleased(cwd, project, version) {
  const name = project.path === "" ? null : project.path.split("/").pop();
  const shapes = [
    `v${version}`,
    version,
    ...(name ? [`${name}/v${version}`] : []),
  ];
  const found = git(["tag", "--list", ...shapes], { cwd, allowFailure: true });
  return (found ?? "").trim() !== "";
}

function commandChange(shared) {
  const { cwd, stdout } = shared;
  const found = scope(shared);
  const noteFile = notePath(cwd);
  fs.writeFileSync(noteFile, "");

  const declared = found.changes.find((change) => change.note.declared) ?? null;
  write(
    stdout,
    JSON.stringify(
      {
        base: found.against,
        forkPoint: found.forkPoint,
        range: found.range,
        noteFile,
        noteFileCleared: true,
        config: {
          file: CONFIG_FILENAME,
          found: found.config.found,
          entryPerChange: !found.config.except.includes("changelog-per-change"),
          except: found.config.except,
        },
        requires: found.part,
        projects: found.projects,
        changes: found.changes,
        note: declared
          ? { ...declared.note, source: `commit ${declared.sha}` }
          : null,
      },
      null,
      2,
    ),
  );
  return EXIT_OK;
}

function commandNote(shared) {
  const { cwd, stdout } = shared;
  const noteFile = notePath(cwd);
  const drafted = shared.none ? "" : readNote(noteFile);
  const note = shared.none
    ? { declared: true, none: true, text: null, blocks: 1 }
    : { declared: true, none: false, text: drafted, blocks: 1 };

  const found = scope(shared);
  const entryPerChange = !found.config.except.includes("changelog-per-change");
  const wanted = shared.subtree
    ? found.projects.filter((project) => project.path === shared.subtree)
    : found.projects;
  if (shared.subtree && wanted.length === 0) {
    throw new HelperError(
      `nothing changed under '${shared.subtree}'`,
      EXIT_USAGE,
    );
  }

  const section = shared.section ?? sectionFor(found.changes);
  const wrote = [];
  const skipped = [];
  for (const project of wanted) {
    const why = refuses(project, entryPerChange, note);
    if (why) {
      skipped.push({ project: project.label, why });
      continue;
    }
    const before = fs.existsSync(project.changelog)
      ? fs.readFileSync(project.changelog, "utf8")
      : null;
    const { text, added } = insertEntry(before, {
      version: project.version,
      date: today(),
      section,
      entry: note.text,
    });
    if (added) {
      fs.writeFileSync(project.changelog, text);
    }
    wrote.push({
      project: project.label,
      changelog: project.changelog,
      version: project.version,
      section,
      added,
    });
  }

  let pullRequest = null;
  if (shared.pullRequest) {
    pullRequest = applyToPullRequest(cwd, shared.pullRequest, note);
  }

  write(
    stdout,
    JSON.stringify(
      { note, noteFile, section, wrote, skipped, pullRequest },
      null,
      2,
    ),
  );
  return EXIT_OK;
}

/** Why an entry does not go in a changelog, in the words the user needs. */
function refuses(project, entryPerChange, note) {
  if (note.none) {
    return "the note is NONE, so there is nothing to write down";
  }
  if (!entryPerChange) {
    return `${CONFIG_FILENAME} excepts changelog-per-change, so the release collates the notes`;
  }
  if (!project.changelog) {
    return "declares no changelog";
  }
  if (project.version === null) {
    return project.unreadable ?? "declares no version";
  }
  if (project.released) {
    const asks = project.asksFor ? `, which asks for ${project.asksFor}` : "";
    return `${project.version} is already released${asks}. Bump it, then run this again`;
  }
  return null;
}

/** The changelog category the branch's types put this under. */
function sectionFor(changes) {
  for (const change of changes) {
    if (change.declares.breaking) {
      return "Changed";
    }
  }
  for (const change of changes) {
    if (change.declares.section) {
      return change.declares.section;
    }
  }
  return null;
}

function readNote(noteFile) {
  let text = "";
  try {
    text = fs.readFileSync(noteFile, "utf8");
  } catch {
    text = "";
  }
  if (text.trim() === "") {
    throw new HelperError(
      `nothing to write. The note goes in ${noteFile} first, or pass --none`,
      EXIT_USAGE,
    );
  }
  return text.trim();
}

/** The block, as it goes in a description. */
export function blockFor(note) {
  return ["```release-note", note.none ? "NONE" : note.text, "```"].join("\n");
}

/** The description with this block in it, replacing one already there. */
export function withBlock(body, note) {
  const block = blockFor(note);
  const text = (body ?? "").replace(/\r\n/g, "\n");
  const found = [...text.matchAll(new RegExp(NOTE_BLOCK.source, "gm"))];
  if (found.length === 0) {
    return text.trim() === ""
      ? `${block}\n`
      : `${text.trimEnd()}\n\n${block}\n`;
  }
  const first = found[0];
  return `${text.slice(0, first.index)}${block}${text.slice(first.index + first[0].length)}`;
}

function applyToPullRequest(cwd, number, note) {
  const body = gh(cwd, [
    "pr",
    "view",
    String(number),
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
  const updated = withBlock(body, note);
  if (updated === body) {
    return { number, changed: false };
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-notes-"));
  const file = path.join(directory, "body.md");
  try {
    fs.writeFileSync(file, updated);
    gh(cwd, ["pr", "edit", String(number), "--body-file", file]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return { number, changed: true };
}

function gh(cwd, args) {
  const result = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new HelperError(`cannot run gh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new HelperError(
      `gh ${args.slice(0, 2).join(" ")}: ${(result.stderr ?? "").trim()}`,
    );
  }
  return result.stdout;
}

function commandWrite(argument, shared) {
  const { cwd, at, subtree, stdout } = shared;
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

  const date = dateFor(cwd, at);
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
  return `Draft a release note: one change's, or a whole release's.

One change, before it is merged:

  node ${invocation} change [--base <ref>] [--path <dir>]
      What this branch changes, as JSON: the fork point, the projects it
      lands in with the version and changelog each declares, every commit
      with what it declares about itself, and the note one already carries.
      Clears the note file, so a run that fails leaves nothing behind.

  node ${invocation} note [--pr <number>] [--path <dir>] [--section <name>] [--none]
      Puts the note drafted in ${NOTE_FILENAME} where it survives: the
      release-note block in the pull request's description, and the entry in
      each changed project's changelog when the repository writes one per
      change. --none declares that a reader can observe nothing.

A release, from the changes that went into it:

  node ${invocation} commits [--since <tag>]
      What is in scope, as JSON: the previous tag, the range, and one row per
      commit. Clears the scratch file, so a run that fails leaves nothing to
      publish.

  node ${invocation} evidence <sha> [--pulls]
      One commit's message, stat, file list and patch, as JSON, with what the
      change declares about itself: the type and scope from the subject, and
      the release-note block if it has one. The patch is omitted past
      ${PATCH_LINE_LIMIT} lines and the stat says how long it was.
      --pulls adds the pull requests it landed through, each with its own
      block, at one API call.

  node ${invocation} section <version> [--at <rev>]
      Reads the body from the scratch file, puts it in CHANGELOG.md under
      '## <version> - <date>' above every older release, and normalises the
      scratch file to the same bytes.
      --at dates the entry from that commit rather than today, for a release
      written up after the fact.

  --path <dir>
      On 'commits' and 'section': draft for one subtree instead of the whole
      repository. The range covers only commits touching it, the entry lands
      in <dir>/CHANGELOG.md, and the scratch file is its own, so a subtree
      draft and a repository draft can be in flight at once. A subtree is
      usually versioned on its own rather than tagged, so pass --since too.
      On 'change' and 'note': the one project to act on, rather than every
      project this branch touched.

Everything about which projects exist, where each keeps its version and its
changelog, and which conventions the repository follows is read from
${CONFIG_FILENAME}. Nothing here is configured twice.
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
        at: { type: "string" },
        path: { type: "string" },
        base: { type: "string" },
        section: { type: "string" },
        pr: { type: "string" },
        pulls: { type: "boolean" },
        none: { type: "boolean" },
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
    at: values.at?.trim() || undefined,
    base: values.base?.trim() || undefined,
    section: values.section?.trim() || undefined,
    subtree: null,
    pulls: values.pulls === true,
    pullRequest: values.pr?.trim() || undefined,
    none: values.none === true,
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
      case "section":
        if (!positionals[1]) {
          throw new HelperError("'section' needs a version", EXIT_USAGE);
        }
        return commandWrite(positionals[1], shared);
      case "change":
        return commandChange(shared);
      case "note":
        return commandNote(shared);
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
