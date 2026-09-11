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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error - skill tooling, deliberately plain JS with no types
import * as agentLock from "../plugins/mutex/skills/mutex/agent-lock.mjs";

const {
  buildNudge,
  commandLock,
  commandRenew,
  commandShow,
  commandUnlock,
  commandStatus,
  detectAgent,
  grantPermissions,
  permissionRules,
  DEFAULT_EXPIRATION_SECONDS,
  sessionId,
  formatRemaining,
  forget,
  preflight,
  main,
  readState,
  remember,
  renderLockTable,
  renderStatusline,
  resolveOwner,
  statePath,
} = agentLock;

/**
 * What the agent's half of the skill has to get right without being told.
 *
 * The lock itself lives in PostgreSQL and is covered elsewhere; what is tested
 * here is the record of it - the owner that has to come back unchanged for an
 * unlock to work, and the expiry that everything ambient reads.
 */

const HOUR = 3600 * 1000;

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lock-")));
  return { root, stateFile: path.join(root, "agent-locks.json") };
}

/** Collects what a command wrote, so the human wording is checked too. */
function capture() {
  const chunks: string[] = [];
  return {
    stream: { write: (text: string) => chunks.push(text) },
    get text() {
      return chunks.join("");
    },
  };
}

/**
 * A `mutex` that answers from a script instead of a database.
 *
 * It also records its arguments, because the arguments are the contract: an
 * hour rather than the CLI's minute, a bounded wait rather than the CLI's
 * whole-lease default, and always the same owner.
 */
function stubMutex(
  root: string,
  responses: Record<string, { stdout?: string; code?: number }>,
) {
  const log = path.join(root, "argv.log");
  const branches = Object.entries(responses)
    .map(([command, response]) => {
      const payload = path.join(root, `${command}.json`);
      fs.writeFileSync(payload, response.stdout ?? "");
      return `  ${command}) cat ${JSON.stringify(payload)}; exit ${response.code ?? 0};;`;
    })
    .join("\n");

  const executable = path.join(root, "mutex-stub.sh");
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\ncase "$1" in\n${branches}\n  *) exit 1;;\nesac\n`,
  );
  fs.chmodSync(executable, 0o755);

  return {
    executable,
    get argv() {
      return fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
        : [];
    },
  };
}

function lockPayload(overrides: Record<string, unknown> = {}) {
  const expiresAt = new Date(Date.now() + HOUR).toISOString();
  return JSON.stringify({
    command: "lock",
    ok: true,
    id: "staging",
    owner: "claude@host:8f3a",
    expires: expiresAt,
    lock: {
      id: "staging",
      reason: "",
      owner: "claude@host:8f3a",
      createdAt: new Date().toISOString(),
      expiresAt,
      expired: false,
    },
    ...overrides,
  });
}

describe("the recorded lock", () => {
  const roots: string[] = [];
  const build = () => {
    const box = sandbox();
    roots.push(box.root);
    return box;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads as empty rather than throwing when the file is unusable", () => {
    const { root, stateFile } = build();
    expect(readState(stateFile)).toEqual({ locks: [] });
    fs.writeFileSync(stateFile, "{ not json");
    expect(readState(stateFile)).toEqual({ locks: [] });
    expect(readState(path.join(root, "nowhere", "x.json"))).toEqual({
      locks: [],
    });
  });

  it("keeps one entry per id, and forgets on request", () => {
    const { stateFile } = build();
    remember(stateFile, { id: "staging", owner: "first" });
    remember(stateFile, { id: "staging", owner: "second" });
    remember(stateFile, { id: "deploy", owner: "third" });

    expect(readState(stateFile).locks).toEqual([
      { id: "staging", owner: "second" },
      { id: "deploy", owner: "third" },
    ]);
    expect(forget(stateFile, "staging")).toBe(true);
    expect(forget(stateFile, "staging")).toBe(false);
    expect(readState(stateFile).locks).toHaveLength(1);
  });

  it("is written where XDG says state belongs", () => {
    expect(statePath({ XDG_STATE_HOME: "/var/state" }, "/home/alice")).toBe(
      "/var/state/releasetools-mutex/agent-locks.json",
    );
    expect(statePath({}, "/home/alice")).toBe(
      "/home/alice/.local/state/releasetools-mutex/agent-locks.json",
    );
  });
});

describe("who the lock belongs to", () => {
  it("uses $MUTEX_OWNER when the environment names one", () => {
    expect(resolveOwner({ MUTEX_OWNER: " ci-run-42 " }, "host")).toBe(
      "ci-run-42",
    );
  });

  it("otherwise names the agent, the host and the session", () => {
    const env = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "22ca1fea-a521" };

    expect(resolveOwner(env, "workstation.local")).toBe(
      "claude@workstation:22ca1fea-a521",
    );
  });

  /**
   * The whole point of deriving it: the name has to be the same one three tool
   * calls later, or the release is refused. It used to end in random bytes.
   */
  it("is the same name every time one session asks", () => {
    const env = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc" };

    expect(resolveOwner(env, "host")).toBe(resolveOwner(env, "host"));
    expect(resolveOwner(env, "host")).not.toBe(
      resolveOwner({ ...env, CLAUDE_CODE_SESSION_ID: "def" }, "host"),
    );
  });

  it("falls back to agent and host when nothing names a session", () => {
    expect(resolveOwner({ CLAUDECODE: "1" }, "workstation.local")).toBe(
      "claude@workstation",
    );
  });

  it("reads the session id each agent publishes, and any it does not", () => {
    expect(sessionId({ CLAUDE_CODE_SESSION_ID: "c1" })).toBe("c1");
    expect(sessionId({ CODEX_THREAD_ID: "t1" })).toBe("t1");
    expect(sessionId({ HERMES_SESSION_ID: "h1" })).toBe("h1");
    expect(sessionId({ ANTIGRAVITY_CONVERSATION_ID: "a1" })).toBe("a1");
    // Found by shape rather than by name, which is what the fallback is for.
    expect(sessionId({ ANTIGRAVITY_AGENT_CONVERSATION_ID: "a2" })).toBe("a2");
    expect(sessionId({ MUTEX_SESSION_ID: "mine", CODEX_THREAD_ID: "t1" })).toBe(
      "mine",
    );
    expect(sessionId({ PATH: "/usr/bin" })).toBeNull();
  });

  it("names the agent it is running inside, and falls back quietly", () => {
    expect(detectAgent({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(detectAgent({ HERMES_SESSION: "1" })).toBe("hermes");
    expect(detectAgent({ ANTIGRAVITY_CONVERSATION_ID: "a1" })).toBe(
      "antigravity",
    );
    // An API key is a credential, not a session. Nothing should read it as one.
    expect(detectAgent({ GEMINI_API_KEY: "secret" })).toBe("agent");
    expect(detectAgent({ MUTEX_AGENT_NAME: "bespoke" })).toBe("bespoke");
    expect(detectAgent({ PATH: "/usr/bin" })).toBe("agent");
  });
});

describe("what the deadline looks like", () => {
  const at = (seconds: number) => ({
    id: "staging",
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
  });

  it("reads at a glance, in minutes above a minute", () => {
    expect(formatRemaining(42)).toBe("42s");
    expect(formatRemaining(600)).toBe("10m");
    expect(formatRemaining(3660)).toBe("1h 1m");
  });

  it("does not say a lock expired 'in' an hour ago", () => {
    const out = capture();
    commandShow({
      stateFile: (() => {
        const box = sandbox();
        remember(box.stateFile, {
          id: "staging",
          owner: "o",
          expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(),
        });
        return box.stateFile;
      })(),
      stdout: out.stream,
    });

    expect(out.text).toContain("(1h 0m ago)");
    expect(out.text).not.toContain("in 1h");
  });

  it("says nothing at all when nothing is held", () => {
    expect(renderStatusline({ locks: [] })).toBe("");
    expect(renderStatusline({ locks: [at(-60)] })).toBe("");
  });

  it("colours by how much is left", () => {
    const plain = (seconds: number) =>
      renderStatusline({ locks: [at(seconds)] }, Date.now(), { color: false });
    expect(plain(2400)).toBe("🔒 staging 40m");

    const coloured = (seconds: number) =>
      renderStatusline({ locks: [at(seconds)] }).slice(0, 5);
    expect(coloured(2400)).toBe("\x1b[36m");
    expect(coloured(300)).toBe("\x1b[33m");
    expect(coloured(60)).toBe("\x1b[31m");
  });

  it("lists every lock this machine holds", () => {
    expect(
      renderStatusline({ locks: [at(2400), at(300)] }, Date.now(), {
        color: false,
      }),
    ).toBe("🔒 staging 40m, staging 5m");
  });
});

describe("the warning before a lock lapses", () => {
  const entry = (seconds: number, nudged: number[] = []) => ({
    id: "staging",
    owner: "claude@host:8f3a",
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
    nudged,
  });

  it("says nothing while there is time", () => {
    const { message, changed } = buildNudge({ locks: [entry(1800)] });
    expect(message).toBe("");
    expect(changed).toBe(false);
  });

  it("asks once per threshold, so a refusal is not re-litigated", () => {
    const first = buildNudge({ locks: [entry(500)] });
    expect(first.message).toContain("expires in 8m");
    expect(first.message).toContain("Ask the user whether to extend it");
    expect(first.state.locks[0].nudged).toEqual([600]);

    expect(buildNudge(first.state).message).toBe("");

    const urgent = buildNudge({ locks: [entry(90, [600])] });
    expect(urgent.message).toContain("expires in 1m");
    expect(urgent.state.locks[0].nudged).toEqual([600, 120]);
  });

  /**
   * Every session on the machine shares the file, which is the point - seeing
   * that something else holds staging is worth knowing. But this session
   * cannot renew or release what it did not take, and telling it to try sends
   * it to be refused by the ownership guard.
   */
  it("offers to extend its own lock, and only mentions another session's", () => {
    const mine = buildNudge(
      { locks: [{ ...entry(500), session: "abc" }] },
      Date.now(),
      "agent-lock.mjs",
      "abc",
    );
    expect(mine.message).toContain("Ask the user whether to extend it");
    expect(mine.message).toContain("extend staging");

    const theirs = buildNudge(
      { locks: [{ ...entry(500), session: "someone-else" }] },
      Date.now(),
      "agent-lock.mjs",
      "abc",
    );
    expect(theirs.message).toContain("Another session on this machine holds");
    expect(theirs.message).toContain("cannot extend or release it from here");
    expect(theirs.message).not.toContain("Ask the user whether to extend");
  });

  it("does not tell a session that somebody else's lock has lapsed", () => {
    const { message, state } = buildNudge(
      { locks: [{ ...entry(-30), session: "someone-else" }] },
      Date.now(),
      "agent-lock.mjs",
      "abc",
    );

    expect(message).toBe("");
    expect(state.locks).toEqual([]);
  });

  it("reports a lock that has gone, then stops tracking it", () => {
    const { message, state } = buildNudge({ locks: [entry(-30)] });
    expect(message).toContain("has expired; you no longer hold it");
    expect(state.locks).toEqual([]);
  });
});

describe("taking, extending and handing back", () => {
  const roots: string[] = [];
  const build = () => {
    const box = sandbox();
    roots.push(box.root);
    return box;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks for an hour and a bounded wait, and writes down what it got", () => {
    const { root, stateFile } = build();
    const mutex = stubMutex(root, { lock: { stdout: lockPayload() } });
    const out = capture();

    const code = commandLock("staging", {
      stateFile,
      executable: mutex.executable,
      owner: "claude@host:8f3a",
      reason: "migrating",
      stdout: out.stream,
    });

    expect(code).toBe(0);
    expect(mutex.argv).toEqual([
      "lock",
      "staging",
      "-e",
      String(DEFAULT_EXPIRATION_SECONDS),
      "-w",
      "30",
      "-o",
      "claude@host:8f3a",
      "--json",
      "-r",
      "migrating",
    ]);
    expect(readState(stateFile).locks[0]).toEqual(
      expect.objectContaining({ id: "staging", owner: "claude@host:8f3a" }),
    );
    expect(out.text).toContain("Acquired 'staging'");
  });

  it("uses try-lock for a single attempt, which takes no waiting options", () => {
    const { root, stateFile } = build();
    const mutex = stubMutex(root, { "try-lock": { stdout: lockPayload() } });

    commandLock("staging", {
      stateFile,
      executable: mutex.executable,
      owner: "o",
      single: true,
      stdout: capture().stream,
    });

    expect(mutex.argv).toEqual([
      "try-lock",
      "staging",
      "-e",
      "3600",
      "-o",
      "o",
      "--json",
    ]);
  });

  it("records nothing when the lock was not acquired, and says who has it", () => {
    const { root, stateFile } = build();
    const mutex = stubMutex(root, {
      lock: {
        code: 4,
        stdout: JSON.stringify({
          command: "lock",
          ok: false,
          id: "staging",
          status: "contended",
          holder: {
            id: "staging",
            owner: "alice",
            reason: "deploying",
            // Half a minute clear of the boundary: at exactly 600s the
            // renderer floors to 9m as soon as any time has passed.
            expiresAt: new Date(Date.now() + 630 * 1000).toISOString(),
          },
        }),
      },
    });
    const out = capture();

    const code = commandLock("staging", {
      stateFile,
      executable: mutex.executable,
      owner: "o",
      stdout: out.stream,
    });

    expect(code).toBe(4);
    expect(readState(stateFile).locks).toEqual([]);
    expect(out.text).toContain("held by: alice");
    expect(out.text).toContain("in 10m");
  });

  it("renews with the owner it recorded, and starts the reminders again", () => {
    const { root, stateFile } = build();
    remember(stateFile, {
      id: "staging",
      owner: "claude@host:8f3a",
      session: "8f3a",
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      nudged: [600, 120],
    });
    const extended = new Date(Date.now() + HOUR).toISOString();
    const mutex = stubMutex(root, {
      renew: {
        stdout: JSON.stringify({
          command: "renew",
          ok: true,
          id: "staging",
          extended: true,
          expires: extended,
          lock: {
            id: "staging",
            owner: "claude@host:8f3a",
            expiresAt: extended,
          },
        }),
      },
    });

    const code = commandRenew("staging", {
      stateFile,
      env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "8f3a" },
      executable: mutex.executable,
      stdout: capture().stream,
    });

    expect(code).toBe(0);
    expect(mutex.argv).toContain("claude@host:8f3a");
    expect(readState(stateFile).locks[0]).toEqual(
      expect.objectContaining({ expiresAt: extended, nudged: [] }),
    );
  });

  it("forgets a lock it handed back", () => {
    const { root, stateFile } = build();
    remember(stateFile, { id: "staging", owner: "claude@host:8f3a" });
    const mutex = stubMutex(root, {
      unlock: {
        stdout: JSON.stringify({ command: "unlock", ok: true, id: "staging" }),
      },
    });

    expect(
      commandUnlock("staging", {
        stateFile,
        executable: mutex.executable,
        stdout: capture().stream,
      }),
    ).toBe(0);
    expect(readState(stateFile).locks).toEqual([]);
  });

  /**
   * The name is derived, so losing the note of a lock does not lose the lock:
   * this is the case the random suffix it replaced could never handle.
   */
  it("releases a lock this session took after the note of it is gone", () => {
    const { root, stateFile } = build();
    const env = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc" };
    const mine = resolveOwner(env);
    const mutex = stubMutex(root, {
      status: {
        stdout: JSON.stringify({
          command: "status",
          id: "staging",
          held: true,
          lock: { id: "staging", owner: mine },
        }),
      },
      unlock: {
        stdout: JSON.stringify({ command: "unlock", ok: true, id: "staging" }),
      },
    });

    const code = commandUnlock("staging", {
      stateFile,
      env,
      executable: mutex.executable,
      stdout: capture().stream,
      stderr: capture().stream,
    });

    expect(code).toBe(0);
    expect(mutex.argv).toContain(mine);
  });

  /**
   * The state file is shared by every session on the machine, so a note that
   * one session can read is not permission to release what another took.
   */
  it("will not release another session's lock through the shared record", () => {
    const { root, stateFile } = build();
    remember(stateFile, {
      id: "deploy",
      owner: "claude@host:someone-else",
      session: "someone-else",
    });
    const mutex = stubMutex(root, {
      status: {
        stdout: JSON.stringify({
          command: "status",
          id: "deploy",
          held: true,
          lock: { id: "deploy", owner: "claude@host:someone-else" },
        }),
      },
      unlock: {
        code: 5,
        stdout: JSON.stringify({
          command: "unlock",
          ok: false,
          id: "deploy",
          outcome: "owned-by-another",
        }),
      },
    });

    const code = commandUnlock("deploy", {
      stateFile,
      env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "mine" },
      executable: mutex.executable,
      stdout: capture().stream,
      stderr: capture().stream,
    });

    expect(code).toBe(5);
    // Never claimed a name it was not entitled to; mutex refused it, as it
    // would refuse anyone who did not name the holder.
    expect(mutex.argv).not.toContain("claude@host:someone-else");
  });

  it("keeps the record when a release is refused, because that is when it matters", () => {
    const { root, stateFile } = build();
    remember(stateFile, { id: "staging", owner: "claude@host:8f3a" });
    const mutex = stubMutex(root, {
      unlock: {
        code: 5,
        stdout: JSON.stringify({
          command: "unlock",
          ok: false,
          id: "staging",
          outcome: "owned-by-another",
        }),
      },
    });
    const out = capture();

    expect(
      commandUnlock("staging", {
        stateFile,
        executable: mutex.executable,
        stdout: out.stream,
      }),
    ).toBe(5);
    expect(readState(stateFile).locks).toHaveLength(1);
    expect(out.text).toContain("stays held until it expires");
  });

  it("reports an expired record as no longer held", () => {
    const { root, stateFile } = build();
    void root;
    remember(stateFile, {
      id: "staging",
      owner: "claude@host:8f3a",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const out = capture();

    commandShow({ stateFile, stdout: out.stream });
    expect(out.text).toContain("expired - you no longer hold it");
  });
});

describe("what is held", () => {
  const roots: string[] = [];
  const build = () => {
    const box = sandbox();
    roots.push(box.root);
    return box;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * "What am I holding?" cannot be answered from the local note: a lock taken
   * from another terminal, or by the Action, is just as much in the way.
   */
  it("asks the table for this session's locks by name", () => {
    const { root } = build();
    const env = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc" };
    const mine = resolveOwner(env);
    const soon = new Date(Date.now() + 600 * 1000).toISOString();
    const mutex = stubMutex(root, {
      list: {
        stdout: JSON.stringify({
          command: "list",
          owner: mine,
          locks: [
            { id: "staging", owner: mine, expiresAt: soon, expired: false },
          ],
        }),
      },
    });
    const out = capture();

    commandStatus(undefined, {
      env,
      executable: mutex.executable,
      stdout: out.stream,
    });

    expect(out.text).toContain(`Yours - ${mine}`);
    expect(out.text).toContain("staging");
    // The database does the narrowing, and the session names itself rather
    // than leaving the answer to whatever $MUTEX_OWNER happens to say.
    expect(mutex.argv).toContain("--owner");
    expect(mutex.argv).toContain(mine);
    // Nobody else's locks were fetched, so none can be reported.
    expect(out.text).not.toContain("Everything else");
    // One round trip, not one per lock.
    expect(
      mutex.argv.filter((argument: string) => argument === "list"),
    ).toHaveLength(1);
  });

  it("splits the whole table on this session's own name for --all", () => {
    const { root } = build();
    const env = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc" };
    const mine = resolveOwner(env);
    const soon = new Date(Date.now() + 600 * 1000).toISOString();
    const mutex = stubMutex(root, {
      list: {
        stdout: JSON.stringify({
          command: "list",
          owner: null,
          locks: [
            { id: "staging", owner: mine, expiresAt: soon, expired: false },
            { id: "deploy", owner: "alice", expiresAt: soon, expired: false },
          ],
        }),
      },
    });
    const out = capture();

    commandStatus(undefined, {
      env,
      all: true,
      executable: mutex.executable,
      stdout: out.stream,
    });

    expect(out.text).toContain(`Yours - ${mine}`);
    expect(out.text).toContain("staging");
    expect(out.text).toContain("Everything else");
    expect(out.text).toMatch(/deploy\s+alice/);
    // Still one round trip: --all names nobody rather than asking twice.
    expect(
      mutex.argv.filter((argument: string) => argument === "list"),
    ).toHaveLength(1);
    expect(mutex.argv).toContain("--owner");
    expect(mutex.argv).not.toContain(mine);
  });

  it("says plainly when this session holds nothing", () => {
    const { root } = build();
    const mutex = stubMutex(root, {
      list: { stdout: JSON.stringify({ command: "list", locks: [] }) },
    });
    const out = capture();

    commandStatus(undefined, {
      env: { CLAUDE_CODE_SESSION_ID: "abc" },
      executable: mutex.executable,
      stdout: out.stream,
    });

    expect(out.text).toMatch(/^Nothing held by /);
  });
});

describe("the table", () => {
  const at = (minutes: number) =>
    new Date(Date.now() + minutes * 60 * 1000).toISOString();

  const record = (overrides = {}) => ({
    id: "staging",
    owner: "claude@host:22ca1fea-a521-4d5c-ad62-b6d05809f8ef",
    reason: "deploying the orders service",
    createdAt: at(-5),
    expiresAt: at(42),
    expired: false,
    ...overrides,
  });

  it("gives every column the user asked for, aligned", () => {
    const [header, row] = renderLockTable([record()]);

    expect(header.split(/\s{2,}/)).toEqual([
      "ID",
      "REASON",
      "TAKEN",
      "EXPIRES",
      "LEFT",
    ]);
    expect(row).toContain("staging");
    expect(row).toContain("deploying the orders service");
    expect(row).toMatch(/\d{2}:\d{2}Z/);
    expect(row.trimEnd()).toMatch(/42m$/);
  });

  it("says how long ago an expired one ran out", () => {
    const [, row] = renderLockTable([record({ expiresAt: at(-70) })]);

    expect(row.trimEnd()).toMatch(/expired 1h 10m ago$/);
  });

  /**
   * A session id is a UUID, and a column of them is 52 characters to scan
   * past. Abbreviated visibly, so nobody copies one thinking it whole.
   */
  it("abbreviates the owner in a list, and never in a single lock", () => {
    const [, listed] = renderLockTable([record()], { owner: true });
    expect(listed).toMatch(/claude@host:22ca1fea-\S*…/);
    expect(listed).not.toContain("ad62-b6d05809f8ef");

    const [, single] = renderLockTable([record()], {
      owner: true,
      fullOwner: true,
    });
    expect(single).toContain(
      "claude@host:22ca1fea-a521-4d5c-ad62-b6d05809f8ef",
    );
  });

  it("keeps a long reason from pushing the columns off the screen", () => {
    const [, row] = renderLockTable([record({ reason: "x".repeat(80) })]);

    expect(row).toContain("…");
    expect(row.length).toBeLessThan(110);
  });
});

/**
 * The command files name a subcommand, and nothing else checks that the helper
 * has one: `/mutex:extend` shipped invoking `extend` while the helper only
 * answered to `renew`, and the failure was a usage message where a renewal
 * should have been.
 */
describe("what the commands invoke", () => {
  const commandsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../plugins/mutex/commands",
  );

  const invoked = fs
    .readdirSync(commandsDir)
    .filter((entry) => entry.endsWith(".md"))
    .flatMap((entry) => {
      const text = fs.readFileSync(path.join(commandsDir, entry), "utf8");
      return [...text.matchAll(/agent-lock\.mjs"?\s+([a-z-]+)/g)].map(
        (match) => [entry, match[1]] as [string, string],
      );
    });

  it("finds a subcommand in the command files at all", () => {
    expect(invoked.length).toBeGreaterThan(2);
  });

  it.each(invoked)(
    "%s invokes a subcommand the helper answers to",
    (_file, subcommand) => {
      const errors: string[] = [];
      main([subcommand, "some-lock"], {
        executable: "/nonexistent-mutex-for-this-test",
        stdout: { write: () => {} },
        stderr: { write: (text: string) => errors.push(text) },
      });

      expect(errors.join("")).not.toContain("unknown command");
    },
  );
});

describe("permission rules", () => {
  const roots: string[] = [];
  const build = () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "perm-")),
    );
    fs.mkdirSync(path.join(root, ".claude"));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const settingsOf = (home: string) =>
    JSON.parse(
      fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"),
    );

  it("covers both spellings of the helper's own invocation", () => {
    expect(permissionRules("/plugins/x/agent-lock.mjs")).toEqual([
      "Bash(mutex:*)",
      "Bash(node /plugins/x/agent-lock.mjs:*)",
      'Bash(node "/plugins/x/agent-lock.mjs":*)',
    ]);
  });

  it("reports what is missing, and writes nothing without being asked", () => {
    const home = build();
    fs.writeFileSync(
      path.join(home, ".claude/settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(cat:*)"] } }),
    );

    const report = grantPermissions({ home, helper: "/x.mjs" });

    expect(report.missing).toHaveLength(3);
    expect(settingsOf(home).permissions.allow).toEqual(["Bash(cat:*)"]);
  });

  it("appends without disturbing anything else, and stays idempotent", () => {
    const home = build();
    fs.writeFileSync(
      path.join(home, ".claude/settings.json"),
      JSON.stringify({
        model: "opus",
        statusLine: { type: "command", command: "x.sh" },
        permissions: { allow: ["Bash(cat:*)"], deny: ["Bash(rm:*)"] },
      }),
    );

    expect(
      grantPermissions({ home, helper: "/x.mjs", write: true }).added,
    ).toHaveLength(3);
    const settings = settingsOf(home);
    expect(settings.model).toBe("opus");
    expect(settings.statusLine).toEqual({ type: "command", command: "x.sh" });
    expect(settings.permissions.deny).toEqual(["Bash(rm:*)"]);
    expect(settings.permissions.allow).toContain("Bash(cat:*)");
    // The list was sorted, so it still is.
    expect([...settings.permissions.allow].sort()).toEqual(
      settings.permissions.allow,
    );

    expect(
      grantPermissions({ home, helper: "/x.mjs", write: true }).added,
    ).toEqual([]);
  });

  /**
   * The cost of being wrong here is somebody's whole configuration, and a
   * permission prompt is a far cheaper failure than a truncated settings file.
   */
  it("refuses a settings file it cannot parse, and leaves it alone", () => {
    const home = build();
    const file = path.join(home, ".claude/settings.json");
    fs.writeFileSync(file, "{ broken");

    expect(
      grantPermissions({ home, helper: "/x.mjs", write: true }).error,
    ).toBeTruthy();
    expect(fs.readFileSync(file, "utf8")).toBe("{ broken");
  });

  it("says so rather than guessing where another agent keeps its permissions", () => {
    const home = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "noclaude-")),
    );
    roots.push(home);

    expect(grantPermissions({ home, helper: "/x.mjs", write: true })).toEqual(
      expect.objectContaining({ supported: false }),
    );
  });
});

describe("preflight", () => {
  const roots: string[] = [];
  const build = () => {
    const box = sandbox();
    roots.push(box.root);
    return box;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops at a CLI that is not installed", () => {
    const { root } = build();
    const report = preflight({
      executable: path.join(root, "does-not-exist"),
      env: {},
      home: root,
    });

    expect(report).toEqual(
      expect.objectContaining({ ok: false, reason: "cli-missing" }),
    );
    expect(report.remedy).toContain("npm install --global @releasetools/mutex");
  });

  it("is ready when the CLI answers, and never repeats the secret", () => {
    const { root } = build();
    const mutex = stubMutex(root, {
      version: { stdout: "1.3.1\n" },
      list: {
        stdout: JSON.stringify({ command: "list", count: 2, locks: [{}, {}] }),
      },
    });

    const report = preflight({
      executable: mutex.executable,
      env: { MUTEX_DATABASE_URL: "postgres://user:hunter2@host/db" },
      home: root,
    });

    expect(report).toEqual(
      expect.objectContaining({
        ok: true,
        reason: "ready",
        locks: 2,
        databaseUrl: true,
      }),
    );
    expect(JSON.stringify(report)).not.toContain("hunter2");
  });

  it("says which name locks will be taken under, and warns when it is shared", () => {
    const { root } = build();
    const mutex = stubMutex(root, {
      version: { stdout: "1.4.0\n" },
      list: { stdout: JSON.stringify({ command: "list", locks: [] }) },
    });

    const named = preflight({
      executable: mutex.executable,
      env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc" },
      home: root,
      host: "workstation.local",
    });
    expect(named.owner).toBe("claude@workstation:abc");
    expect(named.session).toBe("abc");

    const shared = preflight({
      executable: mutex.executable,
      env: { CLAUDECODE: "1" },
      home: root,
      host: "workstation.local",
    });
    expect(shared.owner).toBe("claude@workstation");
    expect(shared.session).toBeNull();
  });

  /**
   * `-p` selects a profile for one command without making it the default, so a
   * preflight run that way has to report the profile it used rather than the
   * one that happens to be the default.
   */
  it("reports the profile -p asked for, not the default one", () => {
    const { root } = build();
    fs.mkdirSync(path.join(root, "releasetools-mutex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "releasetools-mutex", "profiles.toml"),
      '[server]\nmode = "server"\ndefault = true\nbind_address = "localhost:5625"\nworking_dir = "/tmp"\n\n[direct]\nmode = "direct"\ndefault = false\n',
    );
    const mutex = stubMutex(root, {
      version: { stdout: "1.4.0\n" },
      list: { stdout: JSON.stringify({ command: "list", locks: [] }) },
    });

    const report = preflight({
      executable: mutex.executable,
      env: { XDG_CONFIG_HOME: root, MUTEX_DATABASE_URL: "postgres://host/db" },
      home: root,
      profile: "direct",
    });

    expect(report.profile.name).toBe("direct");
    expect(report.requestedProfile).toBe("direct");
    expect(report.message).toContain("selected with -p");
    expect(mutex.argv).toContain("-p");
  });

  it("separates a missing connection string from a server that is not running", () => {
    const { root } = build();
    const missing = stubMutex(root, {
      version: { stdout: "1.3.1\n" },
      list: { code: 3 },
    });
    expect(
      preflight({ executable: missing.executable, env: {}, home: root }),
    ).toEqual(expect.objectContaining({ ok: false, reason: "no-connection" }));

    const { root: second } = build();
    const unreachable = stubMutex(second, {
      version: { stdout: "1.3.1\n" },
      list: { code: 1 },
    });
    expect(
      preflight({ executable: unreachable.executable, env: {}, home: second }),
    ).toEqual(expect.objectContaining({ ok: false, reason: "unreachable" }));
  });

  it("does not blame a server for a direct profile that cannot connect", () => {
    const { root } = build();
    fs.mkdirSync(path.join(root, "releasetools-mutex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "releasetools-mutex", "profiles.toml"),
      '[direct]\nmode = "direct"\ndefault = true\nssl_negotiation = "direct"\n',
    );
    const mutex = stubMutex(root, {
      version: { stdout: "1.4.0\n" },
      list: { code: 1 },
    });

    const report = preflight({
      executable: mutex.executable,
      env: { XDG_CONFIG_HOME: root, MUTEX_DATABASE_URL: "postgres://host/db" },
      home: root,
    });

    expect(report.profile.sslNegotiation).toBe("direct");
    expect(report.remedy).not.toContain("mutex server start");
    expect(report.remedy).toContain("PostgreSQL 17 or newer");
  });

  it("names the profile mutex would use, when there is one", () => {
    const { root } = build();
    fs.mkdirSync(path.join(root, "releasetools-mutex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "releasetools-mutex", "profiles.toml"),
      '[server]\nmode = "server"\ndefault = true\nbind_address = "localhost:5625"\nworking_dir = "/tmp"\n\n[direct]\nmode = "direct"\ndefault = false\n',
    );
    const mutex = stubMutex(root, {
      version: { stdout: "1.3.1\n" },
      list: { code: 1 },
    });

    const report = preflight({
      executable: mutex.executable,
      env: { XDG_CONFIG_HOME: root },
      home: root,
    });

    expect(report.profile).toEqual(
      expect.objectContaining({
        name: "server",
        mode: "server",
        bindAddress: "localhost:5625",
      }),
    );
    expect(report.remedy).toContain("mutex server start");
  });
});
