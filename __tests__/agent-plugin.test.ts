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
import * as installer from "../scripts/install-agent-skills.mjs";

const { parseStrictJson, validatePlugin } = packaging;
const {
  DEFAULT_TARGETS,
  installAgentSkills,
  renderGeminiCommand,
  shippedPlugins,
  shippedSkills,
} = installer;

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
   * lock being taken. An unexpected third is a directory the installer would
   * start copying to every agent, so it has to be named here first.
   */
  it("ships the mutex and naming skills, and nothing else", () => {
    expect(shippedSkills(PLUGIN)).toEqual(["mutex", "naming"]);
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

describe("renderGeminiCommand", () => {
  it("moves the front matter into description and the body into prompt", () => {
    const rendered = renderGeminiCommand(
      "---\nname: lock\ndescription: Take a lock\n---\n\nTake a lock on $ARGUMENTS.\n",
    );

    expect(rendered).toContain('description = "Take a lock"');
    expect(rendered).toContain("Take a lock on {{args}}.");
    expect(rendered).not.toContain("name: lock");
  });

  it("escapes what would otherwise end the string early", () => {
    const rendered = renderGeminiCommand(
      '---\ndescription: d\n---\n\nA backslash \\ and a """ inside.\n',
    );

    expect(rendered).toContain('A backslash \\\\ and a \\"\\"\\" inside.');
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

describe("installAgentSkills", () => {
  const homes: string[] = [];

  const home = (agents: string[]) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "home-")),
    );
    for (const agent of agents) {
      fs.mkdirSync(path.join(root, agent), { recursive: true });
    }
    homes.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of homes.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves Claude and Codex to their manifests unless asked", () => {
    expect(DEFAULT_TARGETS).toEqual(["hermes", "gemini"]);
  });

  it("copies every skill into each agent that is installed", () => {
    const root = home([".hermes", ".gemini"]);
    const { results } = installAgentSkills({ root: PLUGIN, home: root });

    expect(results.map((result: { status: string }) => result.status)).toEqual([
      "written",
      "written",
    ]);
    for (const skill of ["mutex", "naming"]) {
      expect(
        fs.existsSync(
          path.join(root, `.hermes/skills/devops/${skill}/SKILL.md`),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(root, `.gemini/skills/${skill}/SKILL.md`)),
      ).toBe(true);
    }
  });

  /**
   * The commands invoke the helper inside the mutex skill, so installing a
   * subset that leaves that skill out must leave them out too - a slash menu
   * naming a file that was never copied fails at the moment it is used.
   */
  it("installs a named subset, without commands that need what it omits", () => {
    const root = home([".gemini"]);
    installAgentSkills({ root: PLUGIN, home: root, skills: ["naming"] });

    expect(
      fs.existsSync(path.join(root, ".gemini/skills/naming/SKILL.md")),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, ".gemini/skills/mutex"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".gemini/commands"))).toBe(false);
  });

  it("does not create a home for an agent that is not installed", () => {
    const root = home([".hermes"]);
    const { results } = installAgentSkills({ root: PLUGIN, home: root });

    expect(
      results.find((result: { agent: string }) => result.agent === "gemini")
        .status,
    ).toBe("absent");
    expect(fs.existsSync(path.join(root, ".gemini"))).toBe(false);
  });

  it("writes nothing the second time, and reports staleness for CI", () => {
    const root = home([".hermes", ".gemini"]);
    installAgentSkills({ root: PLUGIN, home: root });
    expect(
      installAgentSkills({ root: PLUGIN, home: root, check: true }).results,
    ).toEqual([
      expect.objectContaining({ status: "current" }),
      expect.objectContaining({ status: "current" }),
    ]);

    fs.writeFileSync(
      path.join(root, ".hermes/skills/devops/mutex/SKILL.md"),
      "an older release",
    );
    const { results } = installAgentSkills({
      root: PLUGIN,
      home: root,
      check: true,
    });
    expect(results[0].status).toBe("stale");
    expect(
      fs.readFileSync(
        path.join(root, ".hermes/skills/devops/mutex/SKILL.md"),
        "utf8",
      ),
    ).toBe("an older release");
  });

  /**
   * Gemini reads TOML where Claude Code and Codex read the markdown directly,
   * so its commands are rendered on the way in rather than written twice.
   */
  it("renders the same commands into Gemini's dialect", () => {
    const root = home([".gemini"]);
    installAgentSkills({ root: PLUGIN, home: root });

    const rendered = path.join(root, ".gemini/commands/mutex");
    expect(fs.readdirSync(rendered).sort()).toEqual(
      fs
        .readdirSync(path.join(PLUGIN, "commands"))
        .map((entry) => entry.replace(/\.md$/, ".toml"))
        .sort(),
    );
    const lock = fs.readFileSync(path.join(rendered, "lock.toml"), "utf8");
    expect(lock).toMatch(/^description = "/);
    expect(lock).toContain("{{args}}");
    expect(lock).not.toContain("$ARGUMENTS");

    // Nothing Claude-only survives: the plugin root becomes the path the skill
    // was installed at, and pre-execution becomes Gemini's own syntax.
    for (const file of fs.readdirSync(rendered)) {
      const toml = fs.readFileSync(path.join(rendered, file), "utf8");
      expect(toml).not.toContain("CLAUDE_PLUGIN_ROOT");
      expect(toml).not.toMatch(/!`/);
      if (toml.includes("agent-lock.mjs")) {
        expect(toml).toContain(path.join(root, ".gemini/skills/mutex"));
      }
    }
  });

  it("does not give Hermes commands it cannot read", () => {
    const root = home([".hermes"]);
    installAgentSkills({ root: PLUGIN, home: root });

    expect(fs.existsSync(path.join(root, ".hermes/commands"))).toBe(false);
    expect(
      fs.existsSync(path.join(root, ".hermes/skills/devops/mutex/SKILL.md")),
    ).toBe(true);
  });

  it("refuses an agent it does not know how to install for", () => {
    expect(() =>
      installAgentSkills({
        root: PLUGIN,
        home: home([]),
        targets: ["emacs"],
      }),
    ).toThrow(/unknown agent/);
  });

  /**
   * The agents that read a manifest get every plugin in the marketplace. The
   * ones that read a directory used to get one, which is a plugin that ships
   * and reaches four agents out of six.
   */
  it("installs every plugin in the marketplace, not one of them", () => {
    const root = home([".gemini"]);
    const { plugins } = installAgentSkills({ root: MARKETPLACE, home: root });

    expect(plugins.map((plugin: { name: string }) => plugin.name)).toEqual([
      "mutex",
      "release-notes",
    ]);
    for (const skill of ["mutex", "naming", "release-notes"]) {
      expect(
        fs.existsSync(path.join(root, `.gemini/skills/${skill}/SKILL.md`)),
      ).toBe(true);
    }
    expect(
      fs.existsSync(
        path.join(root, ".gemini/commands/release-notes/draft.toml"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(root, ".gemini/commands/mutex/lock.toml")),
    ).toBe(true);
  });

  it("gives each plugin its own command namespace and skills path", () => {
    const root = home([".gemini"]);
    installAgentSkills({ root: MARKETPLACE, home: root });

    const draft = fs.readFileSync(
      path.join(root, ".gemini/commands/release-notes/draft.toml"),
      "utf8",
    );
    expect(draft).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(draft).toContain(
      path.join(root, ".gemini/skills/release-notes/agent-notes.mjs"),
    );
  });

  it("installs one plugin when it is named", () => {
    const root = home([".gemini"]);
    const { plugins } = installAgentSkills({
      root: MARKETPLACE,
      home: root,
      plugins: ["release-notes"],
    });

    expect(plugins).toHaveLength(1);
    expect(fs.existsSync(path.join(root, ".gemini/skills/release-notes"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, ".gemini/skills/mutex"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".gemini/commands/mutex"))).toBe(
      false,
    );
  });

  it("refuses a plugin this tree does not have", () => {
    expect(() =>
      installAgentSkills({
        root: MARKETPLACE,
        home: home([]),
        plugins: ["callsign"],
      }),
    ).toThrow(/unknown plugin\(s\): callsign/);
  });

  /**
   * Every agent here reads one flat skills directory, so two plugins claiming
   * the same skill name would leave whichever sorted later in place and the
   * other agent following instructions from a plugin nobody installed.
   */
  it("refuses two plugins that ship the same skill name", () => {
    const tree = home([]);
    for (const plugin of ["alpha", "beta"]) {
      const skill = path.join(tree, "plugins", plugin, "skills", "shared");
      fs.mkdirSync(skill, { recursive: true });
      fs.writeFileSync(path.join(skill, "SKILL.md"), `from ${plugin}\n`);
    }

    expect(() => installAgentSkills({ root: tree, home: home([]) })).toThrow(
      /both ship a skill called 'shared'/,
    );
  });

  /**
   * A published npm package carries one plugin's `skills/` and `commands/` at
   * the top level, because a global install is the only checkout most people
   * have. The directory it unpacks into is the plugin's name.
   */
  it("reads a package that carries one plugin at its top level", () => {
    const tree = path.join(home([]), "release-notes");
    fs.mkdirSync(path.join(tree, "skills", "release-notes"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tree, "skills", "release-notes", "SKILL.md"),
      "---\nname: release-notes\n---\n",
    );

    expect(shippedPlugins(tree)).toEqual([
      { name: "release-notes", root: tree },
    ]);
  });
});
