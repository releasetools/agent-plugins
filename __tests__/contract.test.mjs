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
import { Writable } from "node:stream";
import { compareVersions } from "../scripts/catalogs.mjs";
import * as agentLock from "../plugins/mutex/skills/mutex/agent-lock.mjs";

const {
  commandLock,
  commandRenew,
  commandStatus,
  commandUnlock,
  preflight,
  runMutex,
} = agentLock;

/**
 * The helper against a real mutex, rather than a stub of one.
 *
 * `agent-lock.test.ts` covers the helper by writing a shell script that answers
 * however the helper expects, which proves the helper reads its own stub
 * correctly and nothing about the CLI. This proves the other half: that the
 * subcommands it invokes exist, that the flags it passes are accepted, that a
 * failure comes back with the exit code it branches on, and that `--json`
 * carries the fields it reads.
 *
 * It is the seam between two repositories with separate releases, so it is the
 * one thing here that can catch a rename upstream before somebody's `/mutex:lock`
 * does.
 *
 * Needs a mutex on PATH and a database to talk to:
 *
 *     MUTEX_CONTRACT_DATABASE_URL=postgres://... npm test
 */

const DATABASE_URL = process.env.MUTEX_CONTRACT_DATABASE_URL;
const EXECUTABLE = process.env.MUTEX_CONTRACT_BIN ?? "mutex";

/** Whether there is anything to test against, decided once. */
const probe = DATABASE_URL
  ? runMutex(["version"], { executable: EXECUTABLE, env: process.env })
  : { missing: true, status: 127, stdout: "" };
const available = !probe.missing && probe.status === 0;
const cliVersion = available ? probe.stdout.trim() : null;

// Configured but broken has to fail rather than skip. A suite that quietly
// runs nothing is worse than no suite: it reports green for a seam nobody
// checked, which is the thing this was written to stop happening.
const contract = DATABASE_URL ? describe : describe.skip;

/** Some of what the helper uses is newer than the newest published CLI. */
function since(version, name) {
  return cliVersion && compareVersions(cliVersion, version) >= 0
    ? it
    : (title, ...rest) =>
        it.skip(
          `${title} [needs mutex ${version}, this is ${cliVersion}: ${name}]`,
          ...rest,
        );
}

if (!available && !DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.log(
    "contract: skipped. Set MUTEX_CONTRACT_DATABASE_URL and put mutex on PATH to run it.",
  );
}

contract("the mutex CLI, as the helper uses it", () => {
  const roots = [];
  let counter = 0;

  /**
   * A lock nobody else in this run is using, and an environment of its own.
   *
   * Deliberately not `process.env`: a developer's `profiles.toml` can point
   * mutex at a running server rather than at the database given here, and then
   * this measures their machine instead of the contract. Found the hard way -
   * the first run reached a local server speaking a newer protocol than the
   * published CLI understands.
   */
  const scenario = (owner = "contract-owner") => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "contract-")),
    );
    roots.push(root);
    counter += 1;
    return {
      id: `contract-${process.pid}-${counter}`,
      owner,
      options: {
        executable: EXECUTABLE,
        home: path.join(root, "home"),
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, "home"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_STATE_HOME: path.join(root, "state"),
          MUTEX_DATABASE_URL: DATABASE_URL,
        },
        stateFile: path.join(root, "agent-locks.json"),
        owner,
        stdout: new Writable({
          write(chunk, encoding, done) {
            done();
          },
        }),
      },
    };
  };
  const run = (args, { options }) =>
    runMutex(args, { executable: options.executable, env: options.env });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("has a mutex to test against at all", () => {
    expect(probe.missing).toBe(false);
    expect(probe.status).toBe(0);
  });

  it("reports a version the helper can compare", () => {
    expect(cliVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("takes and releases a lock, saying ok in --json", () => {
    const it0 = scenario();
    const taken = run(
      ["lock", it0.id, "-e", "60", "-w", "0", "-o", it0.owner, "--json"],
      it0,
    );

    expect(taken.status).toBe(0);
    expect(taken.json?.ok).toBe(true);

    const released = run(["unlock", it0.id, "-o", it0.owner, "--json"], it0);
    expect(released.status).toBe(0);
    expect(released.json?.ok).toBe(true);
  });

  /**
   * The helper branches on `status === 0 && payload.ok`, and on nothing else,
   * so a refusal has to be both non-zero and honest in its payload.
   */
  it("refuses a lock somebody else holds, and names the holder", () => {
    const held = scenario("first-owner");
    expect(
      run(
        ["lock", held.id, "-e", "60", "-w", "0", "-o", held.owner, "--json"],
        held,
      ).status,
    ).toBe(0);

    const contended = run(
      ["try-lock", held.id, "-e", "60", "-o", "second-owner", "--json"],
      held,
    );

    expect(contended.status).not.toBe(0);
    expect(contended.json?.ok).not.toBe(true);
    expect(JSON.stringify(contended.json)).toContain("first-owner");

    run(["unlock", held.id, "-o", held.owner, "--json"], held);
  });

  it("refuses to release a lock under the wrong owner", () => {
    const held = scenario("rightful-owner");
    run(
      ["lock", held.id, "-e", "60", "-w", "0", "-o", held.owner, "--json"],
      held,
    );

    const refused = run(
      ["unlock", held.id, "-o", "someone-else", "--json"],
      held,
    );
    expect(refused.status).not.toBe(0);

    expect(
      run(["unlock", held.id, "-o", held.owner, "--json"], held).status,
    ).toBe(0);
  });

  it("drives the helper's own lock, renew and unlock", () => {
    const it0 = scenario();

    expect(
      commandLock(it0.id, { ...it0.options, expiration: 60, wait: 0 }),
    ).toBe(0);
    expect(commandRenew(it0.id, { ...it0.options, expiration: 120 })).toBe(0);
    expect(commandUnlock(it0.id, it0.options)).toBe(0);
  });

  it("answers the preflight the skill runs before anything else", () => {
    const it0 = scenario();
    const result = preflight(it0.options);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ready");
    expect(result.version).toBe(cliVersion);
  });

  /**
   * `/mutex:status` asks the table for one owner's locks. The flag landed after
   * 1.3.1, so against an older CLI this skips rather than fails - and starts
   * running by itself the day a new enough mutex is published.
   */
  since("1.4.0", "commandStatus calls `list --owner`")(
    "lists one owner's locks, which is what /mutex:status asks for",
    () => {
      const it0 = scenario();
      run(
        ["lock", it0.id, "-e", "60", "-w", "0", "-o", it0.owner, "--json"],
        it0,
      );

      const listed = run(["list", "--owner", it0.owner, "--json"], it0);
      expect(listed.status).toBe(0);
      expect(JSON.stringify(listed.json)).toContain(it0.id);

      expect(commandStatus(it0.id, it0.options)).toBe(0);

      run(["unlock", it0.id, "-o", it0.owner, "--json"], it0);
    },
  );
});
