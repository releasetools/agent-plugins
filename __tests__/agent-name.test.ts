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

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error - skill tooling, deliberately plain JS with no types
import * as agentLock from "../plugins/mutex/skills/mutex/agent-lock.mjs";

const { deriveName, main, parseRemoteUrl } = agentLock;

/**
 * The `name` subcommand: one resource, one id, on every machine.
 *
 * An advisory lock only excludes callers who ask for the same id, so two
 * agents that derive different ids for the same PR exclude nobody, and the
 * failure is silent. What is tested here is the derivation being the same
 * everywhere - which is why the fixture rows are exact strings, not shapes.
 */

const GITHUB = "git@github.com:ReleaseTools/Mutex.git";
const GITLAB = "https://gitlab.com/group/sub/proj.git";

/** A git that never exists, for the kinds that must not need one. */
const NO_GIT = "/nonexistent-git-for-this-test";

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
 * A `git` that answers `remote get-url` from a script, and records its
 * arguments - the arguments are how `--remote` proves it asked for the right
 * remote rather than always reading origin.
 */
function stubGit(root: string, url: string, code = 0) {
  const log = path.join(root, "git-argv.log");
  const executable = path.join(root, "git-stub.sh");
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\n` +
      (code === 0
        ? `printf '%s\\n' ${JSON.stringify(url)}\n`
        : `echo "error: No such remote" >&2\n`) +
      `exit ${code}\n`,
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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Runs `name` end to end, capturing the streams the contract is about. */
function runName(
  args: string[],
  options: { url?: string; gitCode?: number; git?: string; host?: string } = {},
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "name-")));
  roots.push(root);
  const git =
    options.git === undefined
      ? stubGit(root, options.url ?? "", options.gitCode ?? 0)
      : null;
  const out = capture();
  const err = capture();
  const code = main(["name", ...args], {
    gitExecutable: options.git ?? git?.executable,
    host: options.host,
    stdout: out.stream,
    stderr: err.stream,
  });
  return { code, stdout: out.text, stderr: err.text, git };
}

describe("the fixture table, which two machines must agree on", () => {
  it.each([
    [["issue", "42"], GITHUB, "gh/releasetools/mutex/issue/42"],
    [["pr", "98"], GITHUB, "gh/releasetools/mutex/pr/98"],
    [
      ["branch", "agent/Orange/tsk-9"],
      GITHUB,
      "gh/releasetools/mutex/branch/agent/orange/tsk-9",
    ],
    [["mr", "7"], GITLAB, "glab/group/sub/proj/mr/7"],
  ] as [string[], string, string][])(
    "derives %j from the origin remote",
    (args, url, expected) => {
      const run = runName(args, { url });

      expect(run.stderr).toBe("");
      expect(run.stdout).toBe(`${expected}\n`);
      expect(run.code).toBe(0);
    },
  );

  /**
   * The plain kinds run with no git at all - the executable here does not
   * exist - because an id is needed before a checkout as often as inside one.
   */
  it.each([
    [
      ["notion", "page", "AAB35F24-C808-46F5-A0D3-311A9D78F21F"],
      "notion/page/aab35f24-c808-46f5-a0d3-311a9d78f21f",
    ],
    [["doc", "rfc", "7"], "doc/rfc/0007"],
    [["doc", "rfc", "allocator"], "doc/rfc/allocator"],
    [["pkg", "npm", "@releasetools/mutex"], "pkg/npm/@releasetools/mutex"],
    [["env", "staging"], "env/staging"],
    [["db", "orders", "migrate"], "db/orders/migrate"],
  ] as [string[], string][])(
    "derives %j outside any repository",
    (args, expected) => {
      const run = runName(args, { git: NO_GIT });

      expect(run.stderr).toBe("");
      expect(run.stdout).toBe(`${expected}\n`);
      expect(run.code).toBe(0);
    },
  );

  it("refuses a forge it has no domain for, naming the host", () => {
    const run = runName(["pr", "1"], { url: "git@bitbucket.org:x/y.git" });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("bitbucket.org");
  });
});

describe("what the id is derived from", () => {
  it("reads the same repository out of every remote spelling", () => {
    const expected = { host: "github.com", path: "ReleaseTools/Mutex" };

    expect(parseRemoteUrl("git@github.com:ReleaseTools/Mutex.git")).toEqual(
      expected,
    );
    expect(
      parseRemoteUrl("ssh://git@github.com/ReleaseTools/Mutex.git"),
    ).toEqual(expected);
    expect(parseRemoteUrl("https://github.com/ReleaseTools/Mutex")).toEqual(
      expected,
    );
    expect(parseRemoteUrl("https://gitlab.com/group/sub/proj.git")).toEqual({
      host: "gitlab.com",
      path: "group/sub/proj",
    });
    expect(parseRemoteUrl("nonsense")).toBeNull();
    expect(parseRemoteUrl("")).toBeNull();
  });

  it("takes --repo as the answer, and needs no git for it", () => {
    const run = runName(["release", "--repo", "ReleaseTools/Mutex"], {
      git: NO_GIT,
    });

    expect(run.stdout).toBe("gh/releasetools/mutex/release\n");
  });

  it("maps a --repo host that is not github.com", () => {
    const run = runName(["mr", "7", "--repo", "gitlab.com/group/sub/proj"], {
      git: NO_GIT,
    });

    expect(run.stdout).toBe("glab/group/sub/proj/mr/7\n");
  });

  it("asks git for the remote --remote names", () => {
    const run = runName(["issue", "1", "--remote", "upstream", "--json"], {
      url: GITHUB,
    });

    expect(run.git?.argv).toContain("upstream");
    expect(JSON.parse(run.stdout).source).toBe("upstream remote");
  });

  it("refuses --repo and --remote together: one question, one answer", () => {
    const run = runName(["issue", "1", "--repo", "a/b", "--remote", "up"], {
      git: NO_GIT,
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("not both");
  });

  it("points at --repo when there is no remote to read", () => {
    const missing = runName(["issue", "1"], { gitCode: 2 });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("--repo");

    const noGit = runName(["issue", "1"], { git: NO_GIT });
    expect(noGit.code).toBe(2);
    expect(noGit.stderr).toContain("--repo");
  });

  it("inserts this machine's short hostname for the host kind", () => {
    const run = runName(["host", "port", "5625"], {
      git: NO_GIT,
      host: "Workstation.local",
    });

    expect(run.stdout).toBe("host/workstation/port/5625\n");
  });
});

describe("the platform's own word", () => {
  it("refuses 'mr' against GitHub, and says the word GitHub uses", () => {
    const run = runName(["mr", "7"], { url: GITHUB });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("pull request");
    expect(run.stderr).toContain("'pr'");
  });

  it("refuses 'pr' against GitLab, and says the word GitLab uses", () => {
    const run = runName(["pr", "7"], { url: GITLAB });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("merge request");
    expect(run.stderr).toContain("'mr'");
  });
});

describe("the rules encoded", () => {
  /**
   * Forge numbers are echoed from the platform as decimal, unpadded; doc
   * numbers are our own public face and sort as filenames, so they pad to
   * four. Both normalize, so a zero-padded input cannot mint a second id.
   */
  it("keeps forge numbers unpadded and pads doc numbers to four", () => {
    expect(runName(["issue", "007"], { url: GITHUB }).stdout).toBe(
      "gh/releasetools/mutex/issue/7\n",
    );
    expect(deriveName("doc", ["rfc", "0007"]).id).toBe("doc/rfc/0007");
    expect(deriveName("doc", ["rfc", "12345"]).id).toBe("doc/rfc/12345");
  });

  it("refuses a forge number that is not one", () => {
    const run = runName(["issue", "abc"], { url: GITHUB });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("number");
  });

  it("allows @ in npm package segments, and nowhere else", () => {
    expect(deriveName("pkg", ["npm", "@releasetools/mutex"]).id).toBe(
      "pkg/npm/@releasetools/mutex",
    );
    expect(() => deriveName("pkg", ["brew", "@formula"])).toThrow(
      "outside [a-z0-9._-]",
    );
  });

  /**
   * Deterministic shortening: the final segment becomes the first 12 hex of
   * its sha256, so every agent shortens a too-long id to the same one. Still
   * over is an error, because a second guess would be naming the resource
   * rather than deriving it.
   */
  it("shortens the final segment of an id past 255 characters", () => {
    const long = "x".repeat(300);
    const digest = createHash("sha256").update(long).digest("hex").slice(0, 12);

    expect(deriveName("env", ["logs", long]).id).toBe(`env/logs/${digest}`);
  });

  it("refuses an id that is still over 255 after shortening", () => {
    const wide = Array.from({ length: 4 }, () => "y".repeat(80));

    expect(() => deriveName("env", wide)).toThrow(/255/);
  });

  it("holds each kind to its own arguments", () => {
    expect(runName(["release", "extra"], { url: GITHUB }).code).toBe(2);
    expect(runName(["notion", "table", "id"], { git: NO_GIT }).code).toBe(2);
    expect(runName(["env"], { git: NO_GIT }).code).toBe(2);
    expect(runName(["pkg", "npm"], { git: NO_GIT }).code).toBe(2);
  });

  it("names an unknown kind rather than deriving something", () => {
    const run = runName(["nonsense", "x"], { git: NO_GIT });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("unknown kind 'nonsense'");
  });
});

describe("check, which validates and echoes", () => {
  it("prints a valid id back, including the npm exception", () => {
    expect(runName(["check", "gh/releasetools/mutex/pr/98"]).stdout).toBe(
      "gh/releasetools/mutex/pr/98\n",
    );
    expect(runName(["check", "pkg/npm/@releasetools/mutex"]).stdout).toBe(
      "pkg/npm/@releasetools/mutex\n",
    );
  });

  it("carries the first rule an id broke, and derives nothing", () => {
    const upper = runName(["check", "GH/Bad"]);
    expect(upper.code).toBe(2);
    expect(upper.stdout).toBe("");
    expect(upper.stderr).toContain("lowercase");

    expect(runName(["check", "a//b"]).stderr).toContain("empty segment");
    expect(runName(["check", "/a/b"]).stderr).toContain("slash");
    expect(runName(["check", "a b"]).stderr).toContain("[a-z0-9._-]");
    expect(runName(["check", `a/${"x".repeat(300)}`]).stderr).toContain("255");
  });
});

describe("the output contract", () => {
  it("prints the id alone on stdout, so a substitution composes", () => {
    const run = runName(["pr", "98"], { url: GITHUB });

    expect(run.stdout).toBe("gh/releasetools/mutex/pr/98\n");
    expect(run.stderr).toBe("");
  });

  it("says what was read in --json", () => {
    const remote = runName(["pr", "98", "--json"], { url: GITHUB });
    expect(JSON.parse(remote.stdout)).toEqual({
      id: "gh/releasetools/mutex/pr/98",
      kind: "pr",
      source: "origin remote",
    });

    const argument = runName(["pr", "98", "--repo", "releasetools/mutex"], {
      git: NO_GIT,
    });
    expect(argument.stdout).toBe("gh/releasetools/mutex/pr/98\n");
    const json = runName(
      ["pr", "98", "--repo", "releasetools/mutex", "--json"],
      { git: NO_GIT },
    );
    expect(JSON.parse(json.stdout).source).toBe("argument");
  });
});
