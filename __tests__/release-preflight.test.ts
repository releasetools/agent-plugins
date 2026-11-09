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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `/release:preflight` writes permission rules into a Claude Code settings
 * file, which changes what runs without asking. These hold it to writing only
 * what a release runs, never to starting on its own, and to merging rather
 * than replacing what the file already says.
 */

const PREFLIGHT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "release",
  "skills",
  "preflight",
);
const RULES = path.join(PREFLIGHT, "rules.json");
const SKILL = fs.readFileSync(path.join(PREFLIGHT, "SKILL.md"), "utf8");
const RELEASE = fs.readFileSync(
  path.join(PREFLIGHT, "..", "release", "SKILL.md"),
  "utf8",
);
const WANTED = JSON.parse(fs.readFileSync(RULES, "utf8")).permissions as {
  allow: string[];
  deny: string[];
};

/** A `Bash(...)` rule as a whole-command pattern, `*` matching anything. */
function matches(rule: string, command: string): boolean {
  const body = rule.replace(/^Bash\((.*)\)$/, "$1");
  const pattern = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(command);
}

/** The jq program the skill runs in `shape`, the text after its target. */
function program(shape: string): string {
  const found = [
    ...SKILL.matchAll(/^jq --slurpfile want RULES '(.+)' TARGET(.*)$/gm),
  ].filter((match) => match[2] === shape);
  expect(found).toHaveLength(1);
  return found[0][1];
}

function jq(source: string, settings: object | null): unknown {
  const args = ["--slurpfile", "want", RULES];
  let input: string[] = [];
  if (settings === null) {
    args.unshift("-n");
    source = `{} | ${source}`;
  } else {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "preflight-")),
      "settings.json",
    );
    fs.writeFileSync(file, JSON.stringify(settings));
    input = [file];
  }
  const result = spawnSync("jq", [...args, source, ...input], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

describe("/release:preflight", () => {
  it("runs only when called by name, in both clients", () => {
    const front = SKILL.split("---")[1];
    expect(front).toMatch(/^disable-model-invocation: true$/m);
    expect(
      fs.readFileSync(path.join(PREFLIGHT, "agents", "openai.yaml"), "utf8"),
    ).toBe("policy:\n  allow_implicit_invocation: false\n");
  });

  it("pre-approves no write, so the copy reaches the client's prompt", () => {
    const tools = [...SKILL.split("---")[1].matchAll(/^ {2}- (.+)$/gm)].map(
      (match) => match[1],
    );
    for (const tool of tools) {
      expect(["Write", "Edit"]).not.toContain(tool);
      expect(tool).not.toMatch(/^Bash\((cp|mv|tee|mkdir|rm)\b/);
    }
  });

  it("allows the tag commands the release runs, and none it does not", () => {
    for (const command of [
      'git tag --sign v1.2.3 "$RELEASE_SHA" --message "v1.2.3"',
      "git verify-tag v1.2.3",
      "git push origin refs/tags/v1.2.3",
    ]) {
      expect(WANTED.allow.some((rule) => matches(rule, command))).toBe(true);
    }
    for (const rule of WANTED.allow) {
      expect(RELEASE).toContain(
        rule.replace(/^Bash\((.*)v\*\)$/, "$1v<version>"),
      );
    }
  });

  it("denies a forced push or a moved tag, and nothing the release runs", () => {
    for (const forced of [
      "git push origin refs/tags/v1.2.3 --force",
      "git push origin refs/tags/v1.2.3 -f",
      "git push origin refs/tags/v1.2.3 --force origin",
      'git tag --sign v1.2.3 "$RELEASE_SHA" --message "v1.2.3" --force',
      'git tag --sign v1.2.3 "$RELEASE_SHA" -f --message "v1.2.3"',
    ]) {
      expect(WANTED.deny.some((rule) => matches(rule, forced))).toBe(true);
    }
    const commands = RELEASE.split("\n").filter((line) =>
      /^git (push|tag) /.test(line),
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      for (const rule of WANTED.deny) {
        expect([rule, matches(rule, command)]).toEqual([rule, false]);
      }
    }
  });

  it("appends each missing rule once and keeps everything else", () => {
    const held = WANTED.allow[1];
    const settings = {
      env: { TOKEN: "x" },
      permissions: { allow: ["Bash(mutex list:*)", held], ask: ["Bash(rm *)"] },
      autoMode: { environment: ["trusted"] },
    };
    const missing = program("");
    const merge = program(" > TEMP");

    expect(jq(missing, settings)).toEqual({
      allow: WANTED.allow.filter((rule) => rule !== held),
      deny: WANTED.deny,
    });
    const merged = jq(merge, settings) as typeof settings & {
      permissions: { deny: string[] };
    };
    expect(Object.keys(merged)).toEqual(["env", "permissions", "autoMode"]);
    expect(merged.env).toEqual(settings.env);
    expect(merged.autoMode).toEqual(settings.autoMode);
    expect(merged.permissions).toEqual({
      allow: [
        "Bash(mutex list:*)",
        held,
        ...WANTED.allow.filter((rule) => rule !== held),
      ],
      ask: ["Bash(rm *)"],
      deny: WANTED.deny,
    });
    expect(jq(merge, merged)).toEqual(merged);
    expect(jq(missing, merged)).toEqual({ allow: [], deny: [] });
  });

  it("writes every rule into a file that does not exist yet", () => {
    expect(jq(program(" > TEMP"), null)).toEqual({ permissions: WANTED });
  });
});
