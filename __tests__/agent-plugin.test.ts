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
// @ts-expect-error - packaging tooling, deliberately plain JS with no types
import * as packaging from "../scripts/validate-plugin.mjs";
// @ts-expect-error - packaging tooling, deliberately plain JS with no types
import * as catalogs from "../scripts/catalogs.mjs";

const { parseStrictJson, validatePlugin } = packaging;

/**
 * The plugin is a directory four different agents read, and none of them says
 * anything when the packaging is wrong: a skill they cannot find is
 * indistinguishable from a skill the model chose not to use. These are the
 * mistakes that would otherwise be discovered by somebody asking for a lock
 * and getting a conversation instead.
 */

/** This checkout, which publishes every plugin under `plugins/`. */
const MARKETPLACE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** One published plugin, which is the thing most of these checks are about. */
const PLUGIN = path.join(MARKETPLACE, "plugins", "mutex");

const MANIFEST = {
  name: "mutex",
  version: "0.1.0",
  description: "Guard a shared resource with a distributed lock",
};

function plugin(overrides: Record<string, unknown> = {}) {
  const root = path.join(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-"))),
    "mutex",
  );
  fs.mkdirSync(root);
  const write = (relative: string, contents: string) => {
    fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), contents);
  };

  const claude = { ...MANIFEST, ...((overrides.claude as object) ?? {}) };
  const codex = {
    ...MANIFEST,
    skills: "./skills/",
    commands: "./commands/",
    interface: {
      displayName: "mutex",
      shortDescription: "Distributed locks",
      longDescription: "Distributed locks for guarded operations",
      category: "Developer Tools",
      ...((overrides.face as object) ?? {}),
    },
    ...((overrides.codex as object) ?? {}),
  };

  write(".claude-plugin/plugin.json", JSON.stringify(claude));
  write(".codex-plugin/plugin.json", JSON.stringify(codex));
  if (overrides.portable !== null) {
    write(
      "plugin.json",
      (overrides.portable as string) ??
        catalogs.serializeJson(catalogs.portableManifest(claude)),
    );
  }
  write(
    `skills/${overrides.skillDirectory ?? "mutex"}/SKILL.md`,
    `---\nname: ${overrides.skillName ?? "mutex"}\ndescription: Takes locks\n---\n\n# mutex\n`,
  );
  write("skills/mutex/agent-lock.mjs", "// helper\n");
  write(
    "commands/lock.md",
    `---\nname: ${overrides.commandName ?? "lock"}\ndescription: ${overrides.commandDescription ?? "Take a lock"}\n---\n\nTake a lock on $ARGUMENTS.\n`,
  );
  write(
    "commands/help.md",
    `---\nname: help\ndescription: What this plugin does\n---\n\n- ${overrides.helpLists ?? "/mutex:lock"} - take a lock\n`,
  );
  write(
    "hooks/hooks.json",
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: `node "\${CLAUDE_PLUGIN_ROOT}/${overrides.hookTarget ?? "skills/mutex/agent-lock.mjs"}" nudge`,
              },
            ],
          },
        ],
      },
    }),
  );

  return root;
}

describe("the plugin this repository publishes", () => {
  it("passes validation", () => {
    expect(validatePlugin({ root: PLUGIN }).errors).toEqual([]);
  });

  it("ships one canonical skills directory, not a copy per product", () => {
    expect(fs.lstatSync(path.join(PLUGIN, "skills")).isSymbolicLink()).toBe(
      false,
    );
    for (const product of [".claude-plugin", ".codex-plugin"]) {
      expect(fs.existsSync(path.join(PLUGIN, product, "skills"))).toBe(false);
    }
  });

  /**
   * The two skills answer different questions: naming decides which lock an
   * operation takes and what it is called, mutex decides everything around a
   * lock being taken. An unexpected third is a skill every agent starts
   * loading, so it has to be named here first.
   */
  it("ships the mutex and naming skills, and nothing else", () => {
    const skills = fs
      .readdirSync(path.join(PLUGIN, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skills).toEqual(["mutex", "naming"]);
  });

  it("gives the agents a slash menu, not just a skill", () => {
    const commands = fs
      .readdirSync(path.join(PLUGIN, "commands"))
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => entry.replace(/\.md$/, ""));

    expect(commands).toEqual(
      expect.arrayContaining([
        "preflight",
        "lock",
        "unlock",
        "renew",
        "status",
        "help",
      ]),
    );
    // Starting or stopping the pooled server, choosing profiles and deleting
    // expired locks stay the user's to run, so they get no command.
    expect(commands).not.toEqual(
      expect.arrayContaining(["server", "profile", "prune"]),
    );
  });

  it("keeps the two manifests on the same version", () => {
    const read = (relative: string) =>
      JSON.parse(fs.readFileSync(path.join(PLUGIN, relative), "utf8"));
    expect(read(".codex-plugin/plugin.json").version).toBe(
      read(".claude-plugin/plugin.json").version,
    );
  });
});

describe("validatePlugin", () => {
  const roots: string[] = [];

  const build = (overrides?: Record<string, unknown>) => {
    const root = plugin(overrides);
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a well-formed plugin", () => {
    expect(validatePlugin({ root: build() }).errors).toEqual([]);
  });

  it("catches manifests that have drifted apart", () => {
    const root = build({ codex: { version: "0.2.0" } });
    expect(validatePlugin({ root }).errors).toEqual([
      expect.stringContaining("manifest versions differ"),
    ]);
  });

  it("catches a version that does not match the release being cut", () => {
    const root = build();
    expect(validatePlugin({ root, expected: "9.9.9" }).errors).toHaveLength(2);
  });

  it("catches Codex being pointed somewhere other than skills/", () => {
    const root = build({ codex: { skills: "./.codex-plugin/skills/" } });
    expect(validatePlugin({ root }).errors).toEqual([
      expect.stringContaining('"skills": "./skills/"'),
    ]);
  });

  it("catches a skill whose front matter disagrees with its directory", () => {
    const root = build({ skillName: "locks" });
    expect(validatePlugin({ root }).errors).toEqual([
      expect.stringContaining("is named 'locks'"),
    ]);
  });

  it("catches a hook pointing at a script that moved", () => {
    const root = build({ hookTarget: "skills/mutex/moved.mjs" });
    expect(validatePlugin({ root }).errors).toEqual([
      expect.stringContaining("references a missing file"),
    ]);
  });

  it("catches a second copy of a skill under a product directory", () => {
    const root = build();
    fs.mkdirSync(path.join(root, ".codex-plugin", "skills", "mutex"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, ".codex-plugin", "skills", "mutex", "SKILL.md"),
      "---\nname: mutex\ndescription: a divergent copy\n---\n",
    );
    expect(validatePlugin({ root }).errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(".codex-plugin/skills must not exist"),
        expect.stringContaining("duplicates a skill"),
      ]),
    );
  });

  it("catches a command whose front matter disagrees with its filename", () => {
    const root = build({ commandName: "acquire" });
    expect(validatePlugin({ root }).errors).toEqual([
      expect.stringContaining("commands/lock.md is named 'acquire'"),
    ]);
  });

  it("catches a command with nothing to show in the menu", () => {
    const root = build({ commandDescription: "" });
    expect(validatePlugin({ root }).errors).toEqual([
      expect.stringContaining("commands/lock.md has no description"),
    ]);
  });

  /**
   * A help text that omits a command is worse than none: it reads as a
   * complete list, and the command it leaves out is the one nobody finds.
   */
  it("catches a help command that has stopped listing one", () => {
    const root = build({ helpLists: "/mutex:something-else" });
    expect(validatePlugin({ root }).errors).toEqual([
      expect.stringContaining("help.md does not list /mutex:lock"),
    ]);
  });

  /**
   * The commands exist to be one deterministic invocation. One that runs the
   * helper without declaring it asks for permission every time, which is the
   * stall they were written to remove.
   */
  it("catches a command that runs the helper without declaring it", () => {
    const root = build();
    fs.writeFileSync(
      path.join(root, "commands", "lock.md"),
      "---\nname: lock\ndescription: Take a lock\n---\n\nRun agent-lock.mjs lock.\n",
    );

    expect(validatePlugin({ root }).errors).toEqual([
      expect.stringContaining("runs the helper without allowed-tools"),
    ]);
  });

  it("catches Codex being pointed somewhere other than commands/", () => {
    const root = build({ codex: { commands: "./prompts/" } });
    expect(validatePlugin({ root }).errors).toEqual([
      expect.stringContaining('"commands": "./commands/"'),
    ]);
  });

  /**
   * The commands name the helper by an absolute path the host substitutes, so
   * a helper that is not in the published tree fails at the moment it is run
   * and nowhere earlier - inside a directory the user has never heard of.
   */
  it("catches a command naming a helper that is not there", () => {
    const root = build();
    fs.writeFileSync(
      path.join(root, "commands", "lock.md"),
      "---\nname: lock\ndescription: Take a lock\nallowed-tools: Bash\n---\n" +
        'Run `node "${CLAUDE_PLUGIN_ROOT}/skills/mutex/moved.mjs" lock`.\n',
    );

    expect(validatePlugin({ root }).errors).toEqual([
      expect.stringContaining("commands/lock.md references a missing file"),
    ]);
  });

  it("catches a commands directory that is not there at all", () => {
    const root = build();
    fs.rmSync(path.join(root, "commands"), { recursive: true });

    expect(validatePlugin({ root }).errors).toEqual([
      expect.stringContaining("commands/ is missing"),
    ]);
  });

  /**
   * Codex requires the interface block, and `category` is also the only place
   * the published Codex catalog entry can get a category from.
   */
  /**
   * Hermes and Antigravity clone this repository and look for `plugin.json`
   * where the plugin starts. Neither reads a catalog, so a stale or missing
   * one is not caught anywhere downstream: the plugin simply installs at the
   * wrong version, or is not found at all.
   */
  it("catches a plugin that no agent cloning the repository could find", () => {
    expect(validatePlugin({ root: build({ portable: null }) }).errors).toEqual([
      expect.stringContaining("plugin.json is missing"),
    ]);
  });

  it("catches a portable manifest left behind by a version bump", () => {
    const stale = catalogs.serializeJson(
      catalogs.portableManifest({ ...MANIFEST, version: "0.0.9" }),
    );

    expect(validatePlugin({ root: build({ portable: stale }) }).errors).toEqual(
      [
        expect.stringContaining(
          "plugin.json is not what .claude-plugin/plugin.json describes",
        ),
      ],
    );
  });

  it("publishes the portable manifest the schema names, and nothing else", () => {
    const manifest = catalogs.portableManifest({
      ...MANIFEST,
      author: { name: "ReleaseTools", url: "https://github.com/releasetools" },
      license: "Apache-2.0",
      keywords: ["lock"],
      // Codex's own fields have no place in a format that rejects what it
      // does not know.
      skills: "./skills/",
      interface: { displayName: "mutex" },
    });

    expect(manifest).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "mutex",
      version: "0.1.0",
      description: "Guard a shared resource with a distributed lock",
      author: { name: "ReleaseTools", url: "https://github.com/releasetools" },
      license: "Apache-2.0",
      keywords: ["lock"],
    });
  });

  it("catches a Codex manifest with nothing to display", () => {
    expect(
      validatePlugin({ root: build({ face: { category: "" } }) }).errors,
    ).toEqual([expect.stringContaining("interface.category is missing")]);

    expect(
      validatePlugin({ root: build({ codex: { interface: undefined } }) })
        .errors,
    ).toEqual([expect.stringContaining("has no interface block")]);
  });
});

describe("parseStrictJson", () => {
  it("refuses a repeated key, which JSON.parse resolves silently", () => {
    expect(() =>
      parseStrictJson('{"version":"0.1.0","version":"0.2.0"}'),
    ).toThrow(/duplicate key 'version'/);
  });

  it("allows the same key in different objects", () => {
    expect(parseStrictJson('{"a":{"name":1},"name":2}')).toEqual({
      a: { name: 1 },
      name: 2,
    });
  });

  it("is not fooled by braces and quotes inside strings", () => {
    expect(parseStrictJson('{"a":"{\\"name\\":1}","name":2}')).toEqual({
      a: '{"name":1}',
      name: 2,
    });
  });
});
