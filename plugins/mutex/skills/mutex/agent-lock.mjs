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
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

/**
 * The half of the mutex skill that has to be deterministic.
 *
 * An agent can read the CLI's output and reason about it, but three things
 * cannot be left to reasoning:
 *
 * - **The owner has to survive the session.** `unlock` and `renew` only work
 *   when the name matches exactly, so the name used to take a lock is
 *   generated once here and read back from the state file, rather than
 *   retyped from memory three tool calls later.
 * - **Expiry has to be visible without asking.** A lock is a promise with a
 *   deadline. Anything that has to be queried is a deadline nobody sees, so
 *   what was acquired is written to a small local file that a status line or a
 *   hook can read in a millisecond, with no database round trip.
 * - **A lock must not be forgotten.** Wrapping the acquisition is what keeps
 *   the file honest: there is no path where the lock is taken and the record
 *   of it is not.
 *
 * The state file is a cache and never the truth. PostgreSQL holds the locks;
 * losing this file loses the reminder, not the lock, and `mutex status <id>`
 * still names the owner needed to release it.
 */

/**
 * An hour, where the CLI defaults to a minute.
 *
 * The CLI answers to CI, where a step knows how long it runs. A person working
 * through an agent does not, and a lease that lapses mid-conversation hands
 * the resource to somebody else while the work is still going on. An hour is
 * long enough to be about the work rather than about the clock, and short
 * enough that a session that dies holding one is not a lock for the rest of
 * the day.
 */
export const DEFAULT_EXPIRATION_SECONDS = 3600;

/**
 * How long to wait for a held lock before giving up, in seconds.
 *
 * The CLI's default is the whole lease - an hour here - which for an agent
 * means a tool call that hangs for an hour and a user watching a spinner. Ask
 * for it, wait half a minute, and report back who has it instead.
 */
export const DEFAULT_WAIT_SECONDS = 30;

/**
 * When to speak up about a lock that is running out, in seconds remaining.
 *
 * Each threshold fires once per lock, so a decision not to renew is not
 * re-litigated on every prompt: ten minutes is time to finish or extend, two
 * minutes is the last honest moment to say the guard is about to lapse.
 */
export const NUDGE_THRESHOLDS_SECONDS = [600, 120];

/** The CLI's exit codes, which this script passes through unchanged. */
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_NO_MUTEX = 127;

const STATE_FILENAME = "agent-locks.json";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Where the reminder lives. State, not configuration: XDG says so. */
export function stateDirectory(env = process.env, home = os.homedir()) {
  return env.XDG_STATE_HOME
    ? path.join(path.resolve(env.XDG_STATE_HOME), "releasetools-mutex")
    : path.join(home, ".local", "state", "releasetools-mutex");
}

export function statePath(env = process.env, home = os.homedir()) {
  return path.join(stateDirectory(env, home), STATE_FILENAME);
}

/**
 * Reads the recorded locks, tolerating every way the file can be wrong.
 *
 * A status line and a prompt hook both read this on paths where throwing would
 * be worse than forgetting: a corrupt cache must not break the terminal or
 * refuse a prompt, so anything unreadable is simply no locks.
 */
export function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const locks = Array.isArray(parsed?.locks) ? parsed.locks : [];
    return {
      locks: locks.filter((entry) => entry && typeof entry.id === "string"),
    };
  } catch {
    return { locks: [] };
  }
}

/** Replaces the file atomically, so a reader never sees half a write. */
export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

export function remember(file, entry) {
  const state = readState(file);
  state.locks = [...state.locks.filter((held) => held.id !== entry.id), entry];
  writeState(file, state);
  return state;
}

export function forget(file, id) {
  const state = readState(file);
  const remaining = state.locks.filter((held) => held.id !== id);
  const removed = remaining.length !== state.locks.length;
  if (removed) {
    writeState(file, { locks: remaining });
  }
  return removed;
}

export function findEntry(file, id) {
  return readState(file).locks.find((held) => held.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Seconds left on a recorded lock, or null when the expiry is unreadable. */
export function remainingSeconds(entry, now = Date.now()) {
  const expiry = Date.parse(entry?.expiresAt ?? "");
  return Number.isNaN(expiry) ? null : Math.round((expiry - now) / 1000);
}

export function liveLocks(state, now = Date.now()) {
  return state.locks.filter((entry) => (remainingSeconds(entry, now) ?? 0) > 0);
}

/**
 * A duration a person reads at a glance.
 *
 * Minutes above a minute, deliberately: a status line that counts seconds
 * changes on every redraw and stops being read.
 */
export function formatRemaining(seconds) {
  if (seconds < 0) {
    return `${formatRemaining(-seconds)} ago`;
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Which agent is running, for the human reading `mutex list`.
 *
 * Prefix matching rather than named variables, because every one of these
 * tools ships its own set and they change; being wrong here costs a cosmetic
 * prefix, since what makes an owner unique is the suffix below.
 */
export function detectAgent(env = process.env) {
  if (env.MUTEX_AGENT_NAME?.trim()) {
    return env.MUTEX_AGENT_NAME.trim();
  }
  const prefixes = [
    ["CLAUDE", "claude"],
    ["CODEX", "codex"],
    ["HERMES", "hermes"],
    ["ANTIGRAVITY", "antigravity"],
    ["GEMINI", "gemini"],
  ];
  const keys = Object.keys(env);
  for (const [prefix, name] of prefixes) {
    // A plain prefix, not `PREFIX_`: the commonest marker of them all is
    // `CLAUDECODE`, which an underscore-anchored match misses entirely.
    if (keys.some((key) => key.startsWith(prefix))) {
      return name;
    }
  }
  return "agent";
}

/**
 * The session this is running in, as the agent knows it.
 *
 * Every one of these tools has an id for the conversation and puts it in the
 * environment; the names differ, so the ones that are known are named and
 * anything else is found by shape. `MUTEX_SESSION_ID` is the way out for a
 * tool that does neither.
 */
const SESSION_VARIABLES = [
  "MUTEX_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "HERMES_SESSION_ID",
];

export function sessionId(env = process.env) {
  for (const name of SESSION_VARIABLES) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }

  // An agent not listed above still has a session; take the first variable of
  // its own that is shaped like one.
  for (const name of Object.keys(env).sort()) {
    if (
      /^(CLAUDE|CODEX|HERMES|GEMINI|ANTIGRAVITY)_.*(SESSION|THREAD).*ID$/.test(
        name,
      )
    ) {
      const value = env[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return null;
}

/**
 * The name this lock is taken under: agent, host and session.
 *
 * `$MUTEX_OWNER` wins when it is set, because the CLI already documents it and
 * a workflow that names its locks means it. Otherwise the name says who is
 * holding the lock in terms somebody can act on - `claude@workstation:<id>`
 * names a conversation that can be resumed, or abandoned deliberately.
 *
 * It is derived rather than generated, so it is the same name every time this
 * session asks for it. That is what lets a lock be released after the state
 * file is gone, and what stops one session from releasing another's.
 *
 * With no session id in the environment the name is agent and host alone, and
 * every session on that machine shares it. The preflight says so, because it
 * is the one case where two of your own sessions can take each other's locks
 * back.
 */
export function resolveOwner(env = process.env, host = os.hostname()) {
  const declared = env.MUTEX_OWNER?.trim();
  if (declared) {
    return declared;
  }
  const machine = host.split(".")[0] || "localhost";
  const session = sessionId(env);
  const who = `${detectAgent(env)}@${machine}`;
  return session ? `${who}:${session}` : who;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * One resource, one id, derived rather than composed.
 *
 * An advisory lock only excludes callers who ask for the same id, so two
 * agents that name one resource two ways exclude nobody, and the failure is
 * silent. Everything below is the shared derivation that closes that gap:
 * lowercase always, the platform's own identifiers kept verbatim, and the
 * forge host mapped to a short domain. It is pure string work on purpose -
 * no database, no network, and no git for the kinds that need no repository -
 * so two machines handed the same resource print the same id.
 */

/** The lock table's column is VARCHAR(255); nothing longer can be a lock. */
const MAX_ID_LENGTH = 255;

/**
 * The hosts with a lock domain. Anything else is refused by name rather than
 * guessed at, until a real self-hosted forge decides what it wants.
 */
const FORGE_DOMAINS = { "github.com": "gh", "gitlab.com": "glab" };

/** The kinds that need a repository; everything else stands alone. */
const FORGE_KINDS = ["issue", "pr", "mr", "branch", "release", "admin", "wiki"];

/** The kinds that are just their own segments, joined. */
const PLAIN_KINDS = [
  "env",
  "db",
  "pkg",
  "dns",
  "tf",
  "role",
  "cron",
  "announce",
  "secret",
];

/**
 * The repository behind a git remote URL, whatever the URL's spelling.
 *
 * `git@github.com:Owner/Repo.git`, `https://github.com/owner/repo` and
 * `ssh://git@github.com/owner/repo.git` all name the same repository, and
 * which spelling the clone used must not change the lock id. The path is kept
 * whole rather than split into owner and name, because GitLab nests subgroups.
 */
export function parseRemoteUrl(url) {
  const trimmed = (url ?? "").trim();
  // A scheme first - ssh://, https://, git:// - then the scp-like spelling,
  // which has no scheme and separates host from path with a colon.
  const match =
    /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed) ??
    /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const host = match[1].toLowerCase();
  const slug = match[2].replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  return slug ? { host, path: slug } : null;
}

/** The short domain for a forge host, or the error naming the host. */
function forgeDomain(host) {
  const domain = FORGE_DOMAINS[host];
  if (!domain) {
    throw new Error(
      `unknown forge host '${host}': github.com (gh/) and gitlab.com (glab/) ` +
        `are the hosts with lock domains, and an unlisted one is an error ` +
        `rather than a guess`,
    );
  }
  return domain;
}

/**
 * Which repository a forge kind is about, and where the answer came from.
 *
 * The origin remote is the default because it cannot drift: everybody cloned
 * the same repository. `--repo` is for naming one from outside a checkout,
 * shaped like gh's own flag - `<owner>/<name>`, or `<host>/<path>` when the
 * host is not github.com - and `--remote` reads a different remote of this
 * checkout. Never both: two answers to one question is the disease this
 * command treats.
 */
function resolveForgeRepo(options = {}) {
  if (options.repo && options.remote) {
    throw new Error("pass --repo or --remote, not both");
  }

  if (options.repo) {
    const given = options.repo.toLowerCase().replace(/^\/+|\/+$/g, "");
    const segments = given.split("/");
    if (segments.length < 2 || segments.includes("")) {
      throw new Error(
        `--repo takes <owner>/<name>, or <host>/<path> for a host that is ` +
          `not github.com, not '${options.repo}'`,
      );
    }
    const host = segments.length > 2 ? segments[0] : "github.com";
    const slug = (segments.length > 2 ? segments.slice(1) : segments).join("/");
    return { domain: forgeDomain(host), slug, source: "argument" };
  }

  const remote = options.remote ?? "origin";
  if (remote.startsWith("-")) {
    throw new Error(`--remote must name a git remote, not '${remote}'`);
  }
  const result = spawnSync(
    options.gitExecutable ?? "git",
    ["remote", "get-url", "--", remote],
    {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: options.env ?? process.env,
    },
  );
  if (result.error?.code === "ENOENT") {
    throw new Error("git is not on PATH; pass --repo <owner>/<name> instead");
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `no '${remote}' remote to read here; run this inside the repository, ` +
        `or pass --repo <owner>/<name>`,
    );
  }
  const parsed = parseRemoteUrl(result.stdout);
  if (!parsed) {
    throw new Error(
      `could not read a repository out of the '${remote}' remote's URL`,
    );
  }
  return {
    domain: forgeDomain(parsed.host),
    slug: parsed.path.toLowerCase(),
    source: `${remote} remote`,
  };
}

/**
 * The first rule an id breaks, as the error - or nothing.
 *
 * The grammar is `^[a-z0-9._-]+(/[a-z0-9._-]+)*$`, with one exception: npm
 * publishes scoped packages, so the segments after `pkg/npm/` may open with
 * `@`, and the id matches the name as published.
 */
function assertGrammar(id) {
  if (!id) {
    throw new Error("an id cannot be empty");
  }
  if (id !== id.toLowerCase()) {
    throw new Error(`ids are lowercase: '${id}'`);
  }
  if (id.startsWith("/") || id.endsWith("/")) {
    throw new Error(`ids take no leading or trailing slash: '${id}'`);
  }
  const segments = id.split("/");
  const npmPackage = segments[0] === "pkg" && segments[1] === "npm";
  segments.forEach((segment, index) => {
    if (segment === "") {
      throw new Error(`ids have no empty segments: '${id}'`);
    }
    const pattern =
      npmPackage && index >= 2 ? /^@?[a-z0-9._-]+$/ : /^[a-z0-9._-]+$/;
    if (!pattern.test(segment)) {
      throw new Error(
        `segment '${segment}' has characters outside [a-z0-9._-]: '${id}'`,
      );
    }
  });
}

/**
 * An id the lock table can hold.
 *
 * Past 255 characters the final segment becomes the first 12 hex characters
 * of its sha256 - deterministic, so every agent shortens to the same id - and
 * the check reruns. An id still over after that is refused, because a second
 * guess would be this tool naming the resource instead of deriving it.
 */
function fitId(joined) {
  assertGrammar(joined);
  if (joined.length <= MAX_ID_LENGTH) {
    return joined;
  }
  const segments = joined.split("/");
  const final = segments[segments.length - 1];
  const digest = createHash("sha256").update(final).digest("hex").slice(0, 12);
  const shortened = [...segments.slice(0, -1), digest].join("/");
  assertGrammar(shortened);
  if (shortened.length > MAX_ID_LENGTH) {
    throw new Error(
      `the id is ${shortened.length} characters even after its final segment ` +
        `became 12 hex of its sha256, and at most ${MAX_ID_LENGTH} fit; ` +
        `shorten the earlier segments`,
    );
  }
  return shortened;
}

/** A forge number as the platform prints it: decimal, unpadded. */
function forgeNumber(kind, value) {
  if (!/^\d+$/.test(value ?? "")) {
    throw new Error(`'${kind}' takes a number, not '${value ?? ""}'`);
  }
  return value.replace(/^0+(?=\d)/, "");
}

/**
 * The lock id for a resource, as `name <kind> [args...]` computes it.
 *
 * Returns `{id, kind, source}`, where source says what was read - "origin
 * remote", "argument", "hostname". Throws the first rule the input broke;
 * the caller turns that into stderr and exit 2.
 */
export function deriveName(kind, args = [], options = {}) {
  const want = (kind ?? "").toLowerCase();
  const finish = (parts, source) => {
    const id = fitId(parts.join("/").toLowerCase());
    return { id, kind: want, source };
  };

  if (want === "check") {
    if (args.length !== 1) {
      throw new Error("'check' takes exactly one id");
    }
    const id = args[0];
    assertGrammar(id);
    if (id.length > MAX_ID_LENGTH) {
      throw new Error(
        `ids are at most ${MAX_ID_LENGTH} characters, and this one is ${id.length}`,
      );
    }
    return { id, kind: want, source: "argument" };
  }

  if (FORGE_KINDS.includes(want)) {
    const { domain, slug, source } = resolveForgeRepo(options);
    // The platform's own word is kept, the same verbatim principle that
    // governs ids: a GitHub number after 'mr' is somebody misremembering
    // which forge they are on, which is worth an error rather than an alias.
    if (want === "pr" && domain === "glab") {
      throw new Error(
        "on gitlab.com the word is 'mr' (merge request): use 'mr'",
      );
    }
    if (want === "mr" && domain === "gh") {
      throw new Error(
        "on github.com the word is 'pr' (pull request): use 'pr'",
      );
    }
    if (want === "release" || want === "admin") {
      if (args.length !== 0) {
        throw new Error(`'${want}' takes no arguments`);
      }
      return finish([domain, slug, want], source);
    }
    if (args.length !== 1) {
      throw new Error(
        `'${want}' takes exactly one ${
          want === "branch"
            ? "branch name"
            : want === "wiki"
              ? "slug"
              : "number"
        }`,
      );
    }
    const tail =
      want === "branch" || want === "wiki"
        ? args[0]
        : forgeNumber(want, args[0]);
    return finish([domain, slug, want, tail], source);
  }

  if (want === "notion") {
    const facet = (args[0] ?? "").toLowerCase();
    if (args.length !== 2 || (facet !== "page" && facet !== "db")) {
      throw new Error("'notion' takes 'page' or 'db' and one id");
    }
    return finish(["notion", facet, args[1]], "argument");
  }

  if (want === "doc") {
    if (args.length !== 2) {
      throw new Error("'doc' takes a collection and one number or slug");
    }
    // Doc numbers are zero-padded to four where forge numbers are echoed
    // unpadded: forge numbers are the platform's, these are our own public
    // face and sort as filenames.
    const entry = /^\d+$/.test(args[1])
      ? args[1].replace(/^0+(?=\d)/, "").padStart(4, "0")
      : args[1];
    return finish(["doc", args[0], entry], "argument");
  }

  if (want === "host") {
    if (args.length === 0) {
      throw new Error(
        "'host' takes the machine-scoped resource, as in 'host port 5625'",
      );
    }
    const machine =
      (options.host ?? os.hostname()).split(".")[0] || "localhost";
    return finish(["host", machine, ...args], "hostname");
  }

  if (PLAIN_KINDS.includes(want)) {
    const minimum = want === "pkg" ? 2 : 1;
    if (args.length < minimum) {
      throw new Error(
        want === "pkg"
          ? "'pkg' takes a registry and a package, as in 'pkg npm @releasetools/mutex'"
          : `'${want}' needs at least one segment`,
      );
    }
    return finish([want, ...args], "argument");
  }

  throw new Error(
    `unknown kind '${kind ?? ""}': ${FORGE_KINDS.join(", ")} name forge ` +
      `resources; ${PLAIN_KINDS.join(", ")}, host, notion page|db and doc ` +
      `need no repository; 'check <id>' validates an id you already have`,
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The status line segment: what is held, and how long it lasts.
 *
 * Empty when nothing is held, so appending it to an existing status line costs
 * nothing on the sessions that never take a lock.
 */
export function renderStatusline(state, now = Date.now(), options = {}) {
  const held = liveLocks(state, now);
  if (held.length === 0) {
    return "";
  }

  const soonest = Math.min(
    ...held.map((entry) => remainingSeconds(entry, now) ?? 0),
  );
  const text = `🔒 ${held
    .map(
      (entry) => `${entry.id} ${formatRemaining(remainingSeconds(entry, now))}`,
    )
    .join(", ")}`;

  if (options.color === false) {
    return text;
  }
  const [warn, urgent] = NUDGE_THRESHOLDS_SECONDS;
  const colour = soonest <= urgent ? 31 : soonest <= warn ? 33 : 36;
  return `\x1b[${colour}m${text}\x1b[0m`;
}

/**
 * What to tell the agent, unprompted, about a lock that is running out.
 *
 * Returns the message and the state to persist. Expired locks are reported
 * once and then dropped: the lock is gone from the agent's hands whether or
 * not anyone noticed, and saying so is the point - continuing to act as though
 * a lapsed guard still holds is the failure this exists to prevent.
 */
export function buildNudge(
  state,
  now = Date.now(),
  invocation = "agent-lock.mjs",
  session = null,
) {
  const messages = [];
  const locks = [];

  for (const entry of state.locks) {
    const left = remainingSeconds(entry, now);
    // The file is every session on this machine, deliberately: seeing that
    // something else holds staging is worth knowing. But a lock this session
    // did not take is context, not a thing it can renew or release - saying
    // otherwise sends it to be refused by the ownership guard.
    const ours = !session || !entry.session || entry.session === session;

    if (left === null || left <= 0) {
      if (ours) {
        messages.push(
          `The mutex lock '${entry.id}' has expired; you no longer hold it. ` +
            `Tell the user the guard has lapsed, and do not treat the ` +
            `resource as protected. Somebody else may already have taken it - ` +
            `check with \`mutex status ${entry.id}\` before taking it again.`,
        );
      }
      continue;
    }

    const crossed = NUDGE_THRESHOLDS_SECONDS.filter(
      (threshold) => left <= threshold,
    );
    const nudged = Array.isArray(entry.nudged) ? entry.nudged : [];
    if (crossed.some((threshold) => !nudged.includes(threshold))) {
      messages.push(
        ours
          ? `The mutex lock '${entry.id}' expires in ${formatRemaining(left)}. ` +
              `Ask the user whether to extend it before carrying on with the ` +
              `guarded work; do not renew without being asked. To extend it: ` +
              `\`node ${invocation} extend ${entry.id}\`. To finish and hand ` +
              `it back: \`node ${invocation} unlock ${entry.id}\`.`
          : `Another session on this machine holds the mutex lock ` +
              `'${entry.id}' (${entry.owner ?? "unowned"}), and it expires in ` +
              `${formatRemaining(left)}. Worth mentioning if it is in the way ` +
              `of what the user is doing. You cannot extend or release it from ` +
              `here - only its own session, or somebody naming its owner, can.`,
      );
    }

    locks.push({
      ...entry,
      nudged: [...new Set([...nudged, ...crossed])].sort((a, b) => b - a),
    });
  }

  const next = { locks };
  return {
    message: messages.join("\n\n"),
    state: next,
    changed: JSON.stringify(next) !== JSON.stringify(state),
  };
}

// ---------------------------------------------------------------------------
// The CLI underneath
// ---------------------------------------------------------------------------

/**
 * Runs the real `mutex`, and returns what it said.
 *
 * Never a shell, and arguments always as an array - the same rule the CLI
 * keeps for the programs it wraps. stderr is inherited rather than captured,
 * so contention reports and warnings reach the agent as they happen instead of
 * arriving after the fact.
 */
export function runMutex(args, options = {}) {
  const result = spawnSync(options.executable ?? "mutex", args, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    env: options.env ?? process.env,
  });

  if (result.error) {
    const code = result.error.code;
    if (code === "ENOENT") {
      return { missing: true, status: EXIT_NO_MUTEX, stdout: "", json: null };
    }
    throw result.error;
  }

  const stdout = result.stdout ?? "";
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { missing: false, status: result.status ?? EXIT_ERROR, stdout, json };
}

/**
 * The permission rules an agent needs to run this without stopping to ask.
 *
 * The commands declare their own in front matter, so they never prompt. This is
 * for everything else: the skill invoking the helper directly, and anyone
 * running it by hand. Two spellings of the same path, because a rule is matched
 * against the command string as written and the quoted form is a different
 * string from the bare one.
 */
export function permissionRules(helper) {
  return [
    "Bash(mutex:*)",
    `Bash(node ${helper}:*)`,
    `Bash(node "${helper}":*)`,
  ];
}

/**
 * Adds those rules to Claude Code's settings, additively.
 *
 * Only ever appends, never removes, and refuses to touch a settings file it
 * cannot parse - the cost of being wrong here is somebody's whole
 * configuration, and a permission prompt is a far cheaper failure than that.
 * Writing at all is `--grant`, which only `/mutex:preflight` passes: a skill
 * quietly widening what an agent may run is not a thing this should do.
 *
 * Claude Code only. The other agents keep their permissions in formats this has
 * no business guessing at, so elsewhere it reports the rules and stops.
 */
export function grantPermissions(options = {}) {
  const home = options.home ?? os.homedir();
  const helper = options.helper ?? process.argv[1] ?? "";
  const file =
    options.settingsFile ?? path.join(home, ".claude", "settings.json");
  const wanted = permissionRules(helper);

  if (!fs.existsSync(path.dirname(file))) {
    return { file, supported: false, wanted };
  }

  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      return { file, error: error.message, wanted };
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return { file, error: "settings.json is not a JSON object", wanted };
    }
  }

  const permissions =
    settings.permissions && typeof settings.permissions === "object"
      ? settings.permissions
      : {};
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
  const missing = wanted.filter((rule) => !allow.includes(rule));

  if (missing.length === 0) {
    return { file, added: [], present: wanted };
  }
  if (!options.write) {
    return { file, missing, wanted };
  }

  // Keep the file's own order: these lists are usually sorted, and re-sorting
  // one that is not would churn every line to add three.
  const wasSorted = allow.every(
    (rule, index) => index === 0 || allow[index - 1] <= rule,
  );
  const next = [...allow, ...missing];
  if (wasSorted) {
    next.sort();
  }

  const updated = {
    ...settings,
    permissions: { ...permissions, allow: next },
  };
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
  return { file, added: missing };
}

/**
 * Which profile mutex would use, for the report only.
 *
 * A deliberately small reader, and best-effort by design: it
 * decides what the report *says*, never what it concludes. The verdict below
 * comes from running a command, because a profiles file that parses is not the
 * same as a database that answers.
 *
 * `requested` is `-p`, which selects a profile for one command without making
 * it the default - so a preflight run that way has to report the profile it
 * actually used, not the one that happens to be the default.
 */
export function readDefaultProfile(file, requested = null) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const profiles = [];
  let current = null;
  let defaultProfile = null;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.split("#")[0].trim();
    const section = /^\[([^\]]+)\]$/.exec(stripped);
    if (section) {
      current = {
        name: section[1].trim(),
        mode: null,
        bindAddress: null,
        sslNegotiation: null,
      };
      profiles.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const setting = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(stripped);
    if (!setting) {
      continue;
    }
    const [, key, raw] = setting;
    const value =
      raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (key === "mode") {
      current.mode = value;
    } else if (key === "bind_address") {
      current.bindAddress = value;
    } else if (key === "ssl_negotiation") {
      current.sslNegotiation = value;
    } else if (key === "default" && value === "true") {
      defaultProfile = current;
    }
  }

  if (requested) {
    return profiles.find(({ name }) => name === requested) ?? null;
  }
  return defaultProfile;
}

/**
 * Can this machine reach the lock table at all, and how.
 *
 * Deliberately decided by running a command rather than by reading
 * configuration: profiles select server or direct access explicitly and never
 * fall back to each other, so the only honest answer to "does this work" comes
 * from the CLI itself. `list` is the cheapest read that proves the whole path.
 *
 * It reports whether the connection string is set, never what it is.
 */
export function preflight(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const profilesPath = path.join(
    env.XDG_CONFIG_HOME
      ? path.join(path.resolve(env.XDG_CONFIG_HOME), "releasetools-mutex")
      : path.join(home, ".config", "releasetools-mutex"),
    "profiles.toml",
  );
  const profile = readDefaultProfile(profilesPath, options.profile ?? null);
  const context = {
    profilesPath,
    profilesFile: fs.existsSync(profilesPath),
    profile,
    requestedProfile: options.profile ?? null,
    databaseUrl: Boolean(env.MUTEX_DATABASE_URL),
    owner: resolveOwner(env, options.host ?? os.hostname()),
    session: sessionId(env),
    ownerDeclared: Boolean(env.MUTEX_OWNER?.trim()),
  };

  context.permissions = grantPermissions({
    home,
    helper: options.helper ?? process.argv[1],
    settingsFile: options.settingsFile,
    write: options.grant === true,
  });

  const version = runMutex(["version"], options);
  if (version.missing) {
    return {
      ok: false,
      reason: "cli-missing",
      message: "the mutex CLI is not on PATH",
      remedy:
        "Install it with `npm install --global @releasetools/mutex@1` (Node.js 24 or newer), then run the preflight again.",
      ...context,
    };
  }
  context.version = version.stdout.trim();

  const probe = runMutex(
    ["list", "--json", ...(options.profile ? ["-p", options.profile] : [])],
    options,
  );
  if (probe.status === EXIT_OK) {
    return {
      ok: true,
      reason: "ready",
      mode: profile?.mode ?? "direct",
      message: profile
        ? `mutex answered through the '${profile.name}' profile (${profile.mode})${
            options.profile ? ", selected with -p" : ""
          }`
        : "mutex answered directly, using $MUTEX_DATABASE_URL",
      locks: Array.isArray(probe.json?.locks) ? probe.json.locks.length : null,
      ...context,
    };
  }

  // Exit 3 is the CLI saying it has no usable connection string, and its own
  // stderr has already said which half is missing. Everything else is a path
  // that exists but does not answer - most often a server profile whose server
  // is not running, which is a different fix from a missing secret.
  const configuration = probe.status === 3;
  return {
    ok: false,
    reason: configuration ? "no-connection" : "unreachable",
    mode: profile?.mode ?? "direct",
    message: configuration
      ? "mutex has no usable connection string"
      : `mutex could not reach the lock table (exit ${probe.status})`,
    remedy: remedyFor(profile, configuration),
    ...context,
  };
}

/**
 * What to do about it, in the user's terms.
 *
 * Explicit about who acts: starting a server, exporting a secret and writing a
 * profiles file are all the user's to do. The skill's job is to say which one
 * is missing, not to reach for the secret itself.
 */
function remedyFor(profile, configuration) {
  if (profile?.mode === "server") {
    return configuration
      ? `The '${profile.name}' profile is a server profile, so only the server needs the connection string. Ask the user to start it with \`mutex server start\` in an environment where $MUTEX_DATABASE_URL is visible.`
      : `The '${profile.name}' profile expects a server at ${profile.bindAddress ?? "its bind address"} and nothing answered there. Ask the user to start it with \`mutex server start\` in an environment where $MUTEX_DATABASE_URL is visible; \`mutex server status\` reports whether it is up. A server profile never falls back to opening the database itself.`;
  }
  if (profile?.mode === "direct") {
    if (configuration) {
      return `The '${profile.name}' profile is direct, so this command needs $MUTEX_DATABASE_URL in its own environment. Ask the user to export it - never write it into a file, an argument or a profile.`;
    }
    // mutex names the setting behind a failed handshake in its own error, so
    // point at that rather than guessing over it.
    const negotiation =
      profile.sslNegotiation === "direct"
        ? ` This profile sets \`ssl_negotiation = "direct"\`, which needs PostgreSQL 17 or newer; against anything older the handshake fails.`
        : "";
    return `The '${profile.name}' profile opens the database itself, so nothing here is waiting on a server. Read mutex's own error above - it names the setting behind a failed TLS handshake - and report it.${negotiation}`;
  }
  return configuration
    ? "Export $MUTEX_DATABASE_URL for this command, or ask the user to run `mutex profile` themselves to configure the pooled server. Never put a connection string in an argument: it would be readable from `ps` and left in shell history."
    : "Ask the user how mutex reaches the database here; `mutex server status` reports whether a local server is up.";
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function write(stream, text) {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function describeExpiry(entry, now = Date.now()) {
  const left = remainingSeconds(entry, now);
  if (left === null) {
    return entry.expiresAt ?? "(unknown)";
  }
  // formatRemaining says "ago" itself once the expiry has passed, so only a
  // future one takes "in" - otherwise it reads "in 31h 38m ago".
  return left >= 0
    ? `${entry.expiresAt} (in ${formatRemaining(left)})`
    : `${entry.expiresAt} (${formatRemaining(left)})`;
}

function reportMissingCli(options) {
  write(
    options.stderr ?? process.stderr,
    "agent-lock: the mutex CLI is not on PATH.\n" +
      "  Install it with: npm install --global @releasetools/mutex@1",
  );
  return EXIT_NO_MUTEX;
}

/**
 * Takes a lock and writes down what was taken.
 *
 * The CLI is always asked for JSON, whatever this script was asked for: the
 * expiry and the owner have to be recorded exactly, and re-reading a rendered
 * report to find them is how a state file starts lying.
 */
export function commandLock(id, options = {}) {
  const env = options.env ?? process.env;
  const file = options.stateFile ?? statePath(env, options.home);
  const owner = options.owner ?? resolveOwner(env);
  const expiration = options.expiration ?? DEFAULT_EXPIRATION_SECONDS;
  const stdout = options.stdout ?? process.stdout;

  // try-lock is a single attempt by definition and refuses the waiting
  // options, so the two forms cannot share one argument list.
  const args = options.single
    ? ["try-lock", id, "-e", String(expiration), "-o", owner, "--json"]
    : [
        "lock",
        id,
        "-e",
        String(expiration),
        "-w",
        String(options.wait ?? DEFAULT_WAIT_SECONDS),
        "-o",
        owner,
        "--json",
      ];
  if (options.reason) {
    args.push("-r", options.reason);
  }
  if (options.profile) {
    args.push("-p", options.profile);
  }

  const result = runMutex(args, options);
  if (result.missing) {
    return reportMissingCli(options);
  }

  const payload = result.json;
  if (result.status === EXIT_OK && payload?.ok) {
    const record = payload.lock ?? {};
    const entry = {
      id,
      owner,
      session: sessionId(env),
      reason: options.reason ?? record.reason ?? null,
      createdAt: record.createdAt ?? null,
      expiresAt: payload.expires ?? record.expiresAt ?? null,
      profile: options.profile ?? null,
      agent: detectAgent(env),
      cwd: options.cwd ?? process.cwd(),
      recordedAt: new Date().toISOString(),
      nudged: [],
    };
    remember(file, entry);

    if (options.json) {
      write(stdout, JSON.stringify({ ...payload, state: entry }, null, 2));
    } else {
      write(
        stdout,
        `Acquired '${id}' as '${owner}'.\n` +
          `  expires: ${describeExpiry(entry)}\n` +
          `  release: node ${options.invocation ?? "agent-lock.mjs"} unlock ${id}`,
      );
    }
    return EXIT_OK;
  }

  if (options.json) {
    write(stdout, JSON.stringify(payload ?? { ok: false, id }, null, 2));
  } else {
    const holder = payload?.holder;
    write(
      stdout,
      `Could not acquire '${id}'${payload?.status ? `: ${payload.status}` : ""}.` +
        (holder
          ? `\n  held by: ${holder.owner ?? "(unowned)"}` +
            `\n  expires: ${describeExpiry(holder)}` +
            (holder.reason ? `\n  reason:  ${holder.reason}` : "")
          : ""),
    );
  }
  return result.status;
}

/**
 * Which name to release or renew a lock under, when nothing was recorded here.
 *
 * Guessing is the wrong move in both directions: this session's name is
 * refused on a lock somebody took by hand and left unowned, and an unowned
 * call is refused on a lock this session took before the note of it was lost.
 *
 * So it asks. The name is claimed only when the holder is already this
 * session; anything else is passed as unowned, which leaves the decision where
 * it belongs - with mutex, whose refusal names the holder and says what to
 * pass to override it. Breaking somebody else's lock stays deliberate.
 */
function ownerFor(identifier, entry, options, env) {
  if (options.owner) {
    return options.owner;
  }

  // A lock this session took is released under exactly the name it was taken
  // under, whatever that was. The state file is shared by every session on the
  // machine, so the session has to match: one agent releasing another's lock
  // through a note it happened to be able to read is the thing being prevented.
  const session = sessionId(env);
  if (session && entry?.session === session) {
    return entry.owner ?? null;
  }

  const status = runMutex(
    [
      "status",
      identifier,
      "--json",
      ...(options.profile ? ["-p", options.profile] : []),
    ],
    options,
  );
  const holder = status.json?.lock?.owner ?? null;
  return holder === resolveOwner(env) ? holder : null;
}

/**
 * Extends a lock this machine already recorded.
 *
 * The owner comes from the state file rather than from whoever is calling,
 * because renewing is strict: the id and the owner both have to match, and a
 * near-miss is refused rather than quietly turned into a new lock.
 */
export function commandRenew(id, options = {}) {
  const env = options.env ?? process.env;
  const file = options.stateFile ?? statePath(env, options.home);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const entry = findEntry(file, id);
  const owner = ownerFor(id, entry, options, env);

  if (!entry && !options.owner) {
    write(
      stderr,
      `agent-lock: no recorded lock for '${id}'; renewing as ` +
        `${owner ? `'${owner}'` : "unowned"}, after asking who holds it.`,
    );
  }

  const args = [
    "renew",
    id,
    "-e",
    String(options.expiration ?? DEFAULT_EXPIRATION_SECONDS),
    "--json",
  ];
  if (owner) {
    args.push("-o", owner);
  }
  if (options.profile ?? entry?.profile) {
    args.push("-p", options.profile ?? entry.profile);
  }

  const result = runMutex(args, options);
  if (result.missing) {
    return reportMissingCli(options);
  }

  const payload = result.json;
  if (result.status === EXIT_OK && payload?.ok) {
    const record = payload.lock ?? {};
    const renewed = {
      ...(entry ?? {
        id,
        owner,
        session: sessionId(env),
        agent: detectAgent(env),
      }),
      owner,
      expiresAt:
        payload.expires ?? record.expiresAt ?? entry?.expiresAt ?? null,
      createdAt: record.createdAt ?? entry?.createdAt ?? null,
      recordedAt: new Date().toISOString(),
      // A renewed lock is a fresh deadline, so the reminders start again.
      nudged: [],
    };
    remember(file, renewed);

    if (options.json) {
      write(stdout, JSON.stringify({ ...payload, state: renewed }, null, 2));
    } else {
      write(
        stdout,
        `${payload.extended === false ? "Kept" : "Renewed"} '${id}'.\n` +
          `  expires: ${describeExpiry(renewed)}`,
      );
    }
    return EXIT_OK;
  }

  if (options.json) {
    write(stdout, JSON.stringify(payload ?? { ok: false, id }, null, 2));
  } else {
    write(
      stdout,
      `Could not renew '${id}'${payload?.outcome ? ` (${payload.outcome})` : ""}.`,
    );
  }
  return result.status;
}

/**
 * Hands a lock back.
 *
 * A refusal is left recorded on purpose: exit 5 means the lock is somebody
 * else's now, and forgetting it here would hide that from the status line at
 * the moment it matters most.
 */
export function commandUnlock(id, options = {}) {
  const env = options.env ?? process.env;
  const file = options.stateFile ?? statePath(env, options.home);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const entry = findEntry(file, id);
  const owner = ownerFor(id, entry, options, env);

  if (!entry && !options.owner) {
    write(
      stderr,
      `agent-lock: no recorded lock for '${id}'; releasing as ` +
        `${owner ? `'${owner}'` : "unowned"}, after asking who holds it.`,
    );
  }

  const args = ["unlock", id, "--json"];
  if (owner) {
    args.push("-o", owner);
  }
  if (options.profile ?? entry?.profile) {
    args.push("-p", options.profile ?? entry.profile);
  }

  const result = runMutex(args, options);
  if (result.missing) {
    return reportMissingCli(options);
  }

  const payload = result.json;
  if (result.status === EXIT_OK) {
    forget(file, id);
    if (options.json) {
      write(stdout, JSON.stringify(payload ?? { ok: true, id }, null, 2));
    } else {
      write(
        stdout,
        payload?.outcome === "not-found"
          ? `'${id}' was not held; nothing to unlock.`
          : `Unlocked '${id}'.`,
      );
    }
    return EXIT_OK;
  }

  if (options.json) {
    write(stdout, JSON.stringify(payload ?? { ok: false, id }, null, 2));
  } else {
    write(
      stdout,
      `Could not unlock '${id}'${payload?.outcome ? ` (${payload.outcome})` : ""}. ` +
        `The lock stays held until it expires.`,
    );
  }
  return result.status;
}

/**
 * A UTC timestamp a person reads across a row: the date only when it is not
 * today, since a table of locks is nearly always about the next few hours.
 */
function shortTime(value, now = Date.now()) {
  const at = Date.parse(value ?? "");
  if (Number.isNaN(at)) {
    return "-";
  }
  const iso = new Date(at).toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return day === new Date(now).toISOString().slice(0, 10)
    ? `${time}Z`
    : `${day} ${time}Z`;
}

/** How much lease is left, or how long ago it ran out. */
function timeLeft(record, now = Date.now()) {
  const left = remainingSeconds(record, now);
  if (left === null) {
    return "-";
  }
  return left > 0 ? formatRemaining(left) : `expired ${formatRemaining(left)}`;
}

/**
 * The locks as a table, because a list of them is read by scanning down one
 * column - when does the next one free up, which of these is mine, what was
 * somebody doing.
 */
export function renderLockTable(records, options = {}) {
  const now = options.now ?? Date.now();
  const owner = options.owner === true;
  const reasonWidth = 32;
  // A session id is a UUID, and a column of them is 52 characters of noise to
  // scan past. Abbreviated visibly, so nobody copies one thinking it whole -
  // `mutex status <id>` prints the owner in full when it is needed.
  const ownerWidth = options.fullOwner === true ? Infinity : 28;

  const header = [
    "ID",
    ...(owner ? ["OWNER"] : []),
    "REASON",
    "TAKEN",
    "EXPIRES",
    "LEFT",
  ];
  const rows = records.map((record) => {
    const reason = record.reason || "-";
    const held = record.owner ?? "-";
    return [
      record.id,
      ...(owner
        ? [
            held.length > ownerWidth
              ? `${held.slice(0, ownerWidth - 1)}…`
              : held,
          ]
        : []),
      reason.length > reasonWidth
        ? `${reason.slice(0, reasonWidth - 1)}…`
        : reason,
      shortTime(record.createdAt, now),
      shortTime(record.expiresAt, now),
      timeLeft(record, now),
    ];
  });

  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => row[column].length)),
  );
  // The last column is not padded, so nothing trails into empty space.
  const line = (row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths[column]),
      )
      .join("  ")
      .trimEnd();

  return [line(header), ...rows.map(line)];
}

/**
 * What is held, from the table rather than from the local note.
 *
 * One round trip either way, and it answers the question a person actually
 * asks - "what am I holding?" The local record cannot answer it: a lock taken
 * from another terminal, or by the Action, is just as much in the way.
 *
 * The owner is always named rather than left to `$MUTEX_OWNER`, so the answer
 * is about this session whatever the environment says, and the database does
 * the narrowing. `--all` asks the wider question instead - the whole table,
 * split on this session's name - because with hundreds of locks the other
 * half is noise rather than context, and it costs a table to find that out.
 */
export function commandStatus(identifier, options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const now = options.now ?? Date.now();
  const mine = resolveOwner(env, options.host ?? os.hostname());
  const profile = options.profile ? ["-p", options.profile] : [];

  if (identifier) {
    const result = runMutex(
      ["status", identifier, "--json", ...profile],
      options,
    );
    if (result.missing) {
      return reportMissingCli(options);
    }
    const record = result.json?.lock ?? null;
    if (options.json) {
      write(
        stdout,
        JSON.stringify({ ...(result.json ?? {}), owner: mine }, null, 2),
      );
      return result.status;
    }
    write(
      stdout,
      record
        ? [
            record.owner === mine ? "Yours" : "Held by somebody else",
            ...renderLockTable([record], {
              now,
              owner: record.owner !== mine,
              fullOwner: true,
            }),
          ].join("\n")
        : `${identifier}: not held.`,
    );
    return result.status;
  }

  const all = options.all === true;
  // Naming nobody is how `list` is asked for the whole table; naming this
  // session is how it is asked for one row per lock actually held here.
  const result = runMutex(
    ["list", "--owner", all ? "" : mine, "--json", ...profile],
    options,
  );
  if (result.missing) {
    return reportMissingCli(options);
  }
  const locks = Array.isArray(result.json?.locks) ? result.json.locks : [];
  const yours = all ? locks.filter((lock) => lock.owner === mine) : locks;
  const others = all ? locks.filter((lock) => lock.owner !== mine) : [];

  if (options.json) {
    // `others` is absent rather than empty when it was not asked for: "none"
    // and "not looked for" are different answers.
    write(
      stdout,
      JSON.stringify(
        { owner: mine, yours, ...(all ? { others } : {}) },
        null,
        2,
      ),
    );
    return result.status;
  }

  write(
    stdout,
    [
      yours.length > 0
        ? [`Yours - ${mine}`, ...renderLockTable(yours, { now })].join("\n")
        : `Nothing held by ${mine}.`,
      others.length > 0
        ? [
            "",
            "Everything else",
            ...renderLockTable(others, { now, owner: true }),
          ].join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return result.status;
}

/** What this machine has written down that it holds, without asking the table. */
export function commandShow(options = {}) {
  const env = options.env ?? process.env;
  const file = options.stateFile ?? statePath(env, options.home);
  const stdout = options.stdout ?? process.stdout;
  const now = options.now ?? Date.now();
  const state = readState(file);

  if (options.json) {
    write(
      stdout,
      JSON.stringify(
        {
          stateFile: file,
          locks: state.locks.map((entry) => ({
            ...entry,
            remainingSeconds: remainingSeconds(entry, now),
            expired: (remainingSeconds(entry, now) ?? 0) <= 0,
          })),
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  if (state.locks.length === 0) {
    write(stdout, `No locks recorded in ${file}.`);
    return EXIT_OK;
  }

  for (const entry of state.locks) {
    const left = remainingSeconds(entry, now);
    write(
      stdout,
      `${entry.id}\n` +
        `  owner:   ${entry.owner ?? "(none)"}\n` +
        `  state:   ${(left ?? 0) > 0 ? "held" : "expired - you no longer hold it"}\n` +
        `  expires: ${describeExpiry(entry, now)}\n` +
        `  taken:   ${entry.recordedAt ?? "(unknown)"} in ${entry.cwd ?? "(unknown)"}`,
    );
  }
  return EXIT_OK;
}

/** One line for a status line. Nothing at all when nothing is held. */
export function commandStatusline(options = {}) {
  const file =
    options.stateFile ?? statePath(options.env ?? process.env, options.home);
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const segment = renderStatusline(readState(file), options.now ?? Date.now(), {
    color: options.color !== false && !env.NO_COLOR,
  });
  if (segment) {
    write(stdout, segment);
  }
  return EXIT_OK;
}

/**
 * The unprompted half: a Claude Code `UserPromptSubmit` hook.
 *
 * Never fails and never blocks a prompt. A reminder that a lock is running out
 * is worth having; a hook that can refuse the user's next message because a
 * cache file was malformed is not.
 */
export function commandNudge(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  try {
    const file =
      options.stateFile ?? statePath(options.env ?? process.env, options.home);
    const state = readState(file);
    if (state.locks.length === 0) {
      return EXIT_OK;
    }

    const {
      message,
      state: next,
      changed,
    } = buildNudge(
      state,
      options.now ?? Date.now(),
      options.invocation ?? process.argv[1] ?? "agent-lock.mjs",
      sessionId(options.env ?? process.env),
    );
    if (changed) {
      writeState(file, next);
    }
    if (message) {
      write(
        stdout,
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: message,
          },
        }),
      );
    }
  } catch {
    // Deliberately silent: see above.
  }
  return EXIT_OK;
}

/**
 * Derives the lock id for a resource, and prints it alone.
 *
 * The id is the whole answer and stdout carries nothing else - diagnostics go
 * to stderr, the same split the CLI keeps - so `id="$(... name pr 98)"`
 * composes. Exit 2 carries the first rule the input broke.
 */
export function commandName(positionals, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const [kind, ...args] = positionals;

  let named;
  try {
    named = deriveName(kind, args, options);
  } catch (error) {
    write(stderr, `agent-lock: name: ${error.message}`);
    return EXIT_USAGE;
  }

  write(stdout, options.json ? JSON.stringify(named, null, 2) : named.id);
  return EXIT_OK;
}

/** Drops a recorded lock without touching the lock itself. */
export function commandForget(id, options = {}) {
  const file =
    options.stateFile ?? statePath(options.env ?? process.env, options.home);
  const stdout = options.stdout ?? process.stdout;
  write(
    stdout,
    forget(file, id)
      ? `Forgot '${id}'. The lock itself is untouched and still expires on its own.`
      : `No recorded lock for '${id}'.`,
  );
  return EXIT_OK;
}

function describePermissions(state) {
  if (!state) {
    return "not checked";
  }
  if (state.supported === false) {
    return "not applicable here - no Claude Code settings to add them to";
  }
  if (state.error) {
    return `could not read ${state.file}: ${state.error}`;
  }
  if (state.added?.length) {
    return `added ${state.added.length} rule(s) to ${state.file}; restart the session if a prompt still appears`;
  }
  if (state.missing?.length) {
    return `${state.missing.length} rule(s) missing from ${state.file} - run /mutex:preflight to add them`;
  }
  return `already allowed in ${state.file}`;
}

export function commandPreflight(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const report = preflight(options);

  if (options.json) {
    write(stdout, JSON.stringify(report, null, 2));
    return report.ok ? EXIT_OK : EXIT_ERROR;
  }

  const profile = report.profile
    ? `${report.profile.name} (${report.profile.mode}${
        report.profile.bindAddress ? `, ${report.profile.bindAddress}` : ""
      })`
    : report.requestedProfile
      ? `'${report.requestedProfile}' is not defined in that file`
      : "none - zero-configuration direct access";
  const lines = [
    report.ok ? `ready: ${report.message}` : `not ready: ${report.message}`,
    `  mutex:              ${report.version ?? "(not found)"}`,
    `  profiles file:      ${report.profilesFile ? report.profilesPath : `none (${report.profilesPath})`}`,
    `  ${report.requestedProfile ? "profile (-p):     " : "default profile:  "}  ${profile}`,
    `  MUTEX_DATABASE_URL: ${report.databaseUrl ? "set" : "not set"}`,
    `  permissions:        ${describePermissions(report.permissions)}`,
    `  locks taken as:     ${report.owner}${
      report.ownerDeclared
        ? " (from $MUTEX_OWNER)"
        : report.session
          ? ""
          : " - no session id in the environment, so every session on this machine shares this name and can release its locks"
    }`,
  ];
  if (report.locks !== null && report.locks !== undefined) {
    lines.push(`  locks in table:     ${report.locks}`);
  }
  if (report.remedy) {
    lines.push(`  remedy: ${report.remedy}`);
  }
  write(stdout, lines.join("\n"));
  return report.ok ? EXIT_OK : EXIT_ERROR;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const OPTION_CONFIG = {
  reason: { type: "string", short: "r" },
  expiration: { type: "string", short: "e" },
  wait: { type: "string", short: "w" },
  owner: { type: "string", short: "o" },
  profile: { type: "string", short: "p" },
  repo: { type: "string" },
  remote: { type: "string" },
  try: { type: "boolean" },
  grant: { type: "boolean" },
  all: { type: "boolean" },
  json: { type: "boolean" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export function usage(invocation = "agent-lock.mjs") {
  return `agent-lock - the mutex skill's helper: takes locks and remembers them

Usage: node ${invocation} <command> [<id>] [options]

Commands:
  preflight        Report whether mutex can reach the lock table here
                   (--grant also adds the permission rules it needs)
  name <kind> ...  Derive a resource's lock id and print it alone, so every
                   agent computes the same one: issue, pr, mr, branch,
                   release, admin and wiki read the origin remote; env, db,
                   pkg, dns, tf, host, role, cron, announce, secret,
                   notion page|db and doc need no repository; 'name check
                   <id>' validates an id you already have
  lock <id>        Take a lock, and record what was taken
  renew <id>       Extend a recorded lock, keeping its owner
  unlock <id>      Hand a recorded lock back
  status [id]      What you hold, from the table - or who holds one lock
                   (--all also lists what everybody else is holding)
  show             What this machine wrote down, without asking the table
  statusline       One line for a status line; empty when nothing is held
  nudge            Claude Code UserPromptSubmit hook: warn before a lock lapses
  forget <id>      Drop a recorded lock without touching the lock itself

Options:
  -r, --reason <text>         Why the lock is being taken
  -e, --expiration <seconds>  How long it lasts (default: ${DEFAULT_EXPIRATION_SECONDS})
  -w, --wait <seconds>        How long to wait for it (default: ${DEFAULT_WAIT_SECONDS})
      --try                   One attempt, no waiting
  -o, --owner <name>          Override the recorded owner
  -p, --profile <name>        Use one mutex profile for this command
      --repo <owner>/<name>   name: this repository instead of the origin
                              remote (<host>/<path> when not github.com)
      --remote <name>         name: read this git remote instead of origin
      --all                   status: the whole table, not only your locks
      --json                  Machine-readable output
      --no-color              No ANSI colour in the status line
  -h, --help                  Show this

Every lock operation goes through the mutex CLI, which reads its connection
string from $MUTEX_DATABASE_URL and from nowhere else; 'name' derives ids from
strings alone and opens no connection at all. This script never sees the
secret, never prints it, and never passes it as an argument.
`;
}

/** A whole number of seconds, and nothing else pretending to be one. */
function readSeconds(value, name) {
  if (value === undefined) {
    return undefined;
  }
  const text = String(value).startsWith("=")
    ? String(value).slice(1)
    : String(value);
  if (!/^\d+$/.test(text) || Number(text) <= 0) {
    throw new Error(
      `--${name} must be a whole number of seconds above 0, not '${value}'`,
    );
  }
  return Number(text);
}

export function main(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const invocation = options.invocation ?? "agent-lock.mjs";

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTION_CONFIG,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    write(stderr, `agent-lock: ${error.message}`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  const command = positionals[0] ?? "help";
  const id = positionals[1];

  if (values.help || command === "help") {
    write(stdout, usage(invocation));
    return EXIT_OK;
  }

  let shared;
  try {
    shared = {
      ...options,
      invocation,
      json: values.json === true,
      color: values["no-color"] !== true,
      reason: values.reason,
      owner: values.owner?.trim() || undefined,
      profile: values.profile?.trim() || undefined,
      repo: values.repo?.trim() || undefined,
      remote: values.remote?.trim() || undefined,
      single: values.try === true,
      grant: values.grant === true,
      all: values.all === true,
      expiration: readSeconds(values.expiration, "expiration"),
      wait: readSeconds(values.wait, "wait"),
    };
  } catch (error) {
    write(stderr, `agent-lock: ${error.message}`);
    return EXIT_USAGE;
  }

  const needsId = ["lock", "renew", "unlock", "forget"];
  if (needsId.includes(command) && !id) {
    write(stderr, `agent-lock: '${command}' needs a lock id`);
    return EXIT_USAGE;
  }

  switch (command) {
    case "preflight":
      return commandPreflight(shared);
    case "name":
      return commandName(positionals.slice(1), shared);
    case "lock":
      return commandLock(id, shared);
    case "renew":
      return commandRenew(id, shared);
    case "unlock":
      return commandUnlock(id, shared);
    case "status":
      return commandStatus(id, shared);
    case "show":
      return commandShow(shared);
    case "statusline":
      return commandStatusline(shared);
    case "nudge":
      return commandNudge(shared);
    case "forget":
      return commandForget(id, shared);
    default:
      write(
        stderr,
        `agent-lock: unknown command '${command}'\n\n${usage(invocation)}`,
      );
      return EXIT_USAGE;
  }
}

// Run directly, rather than imported by a test.
if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  process.exitCode = main(process.argv.slice(2), {
    invocation: process.argv[1],
  });
}
