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
import { parseArgs } from "node:util";

/**
 * Puts the skills where an agent that cannot install this plugin looks for them.
 *
 * Four of the five install it properly. Claude Code and Codex resolve it
 * through a catalog; Hermes and Antigravity clone the repository and read
 * `plugin.json`. Gemini CLI is the exception: an extension has to sit at the
 * root of a repository or a release archive, and every plugin here is in a
 * subdirectory, so a copy is the only way in.
 *
 * Google retired Gemini CLI for individual accounts on 18 June 2026 in favour
 * of Antigravity CLI, so that route now serves the Gemini Code Assist licences
 * and API keys that still reach it, and nothing else. Antigravity is not among
 * them: it reads `~/.gemini/config/skills` and its own plugin directory, not
 * the `~/.gemini/skills` this writes.
 *
 * It still installs for Hermes and Antigravity on request, and the mutex npm
 * package runs it from its own top level, where a global CLI installation is
 * the only checkout most people have.
 *
 * Copies rather than symlinks. A symlink into a git worktree turns "I deleted
 * that branch" into "my agent lost a skill", and these directories outlive the
 * checkouts they came from.
 */

export const TARGETS = [
  {
    agent: "hermes",
    home: ".hermes",
    // Hermes groups skills by category, and these are the devops ones.
    skills: path.join("skills", "devops"),
  },
  {
    agent: "gemini",
    home: ".gemini",
    skills: "skills",
    // Gemini reads TOML rather than the markdown Claude Code and Codex share,
    // so the same command files are rendered on the way in. Subdirectories are
    // namespaces there, so `commands/mutex/lock.toml` is `/mutex:lock`.
    commands: "commands",
  },
  {
    agent: "claude",
    home: ".claude",
    skills: "skills",
    manifest:
      "install the plugin instead: /plugin marketplace add releasetools/agent-plugins",
  },
  {
    agent: "codex",
    home: ".codex",
    skills: "skills",
    manifest:
      "install the plugin instead: codex plugin marketplace add releasetools/agent-plugins",
  },
];

/** The ones installed unless the caller names others. */
export const DEFAULT_TARGETS = TARGETS.filter((target) => !target.manifest).map(
  (target) => target.agent,
);

function filesUnder(root, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), {
    withFileTypes: true,
  })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(root, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

/**
 * One command file, in the dialect Gemini reads.
 *
 * The markdown is the original: Claude Code and Codex both read `commands/`
 * directly, and only Gemini needs a translation. Keeping that translation
 * mechanical - front matter to `description`, body to `prompt`, `$ARGUMENTS`
 * to `{{args}}`, `!`cmd`` to `!{cmd}`, and the plugin root to the directory the
 * skills land in - is what stops the two from drifting into different
 * instructions. The rewrite is by prefix, so a command reaching into any of its
 * plugin's skills resolves without this knowing their names.
 */
export function renderGeminiCommand(markdown, options = {}) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  const description = front
    ? (/^description:\s*(.+)$/m.exec(front[1])?.[1]?.trim() ?? "")
    : "";
  const body = (front ? markdown.slice(front[0].length) : markdown).trim();
  const prompt = body
    // Claude Code substitutes the plugin root and runs `!`cmd`` before the
    // model sees the prompt. Gemini spells that `!{cmd}` and has no plugin
    // root, so the path the skill will actually sit at is written in.
    .replaceAll("${CLAUDE_PLUGIN_ROOT}/skills", options.skills ?? ".")
    .replace(/!`([^`]*)`/g, "!{$1}")
    .replaceAll("$ARGUMENTS", "{{args}}")
    // A TOML basic multi-line string, so a backslash or a stray triple quote in
    // the prose cannot end it early or be read as an escape.
    .replaceAll("\\", "\\\\")
    .replaceAll('"""', '\\"\\"\\"');

  return `description = ${JSON.stringify(description)}\n\nprompt = """\n${prompt}\n"""\n`;
}

/**
 * The skills a checkout ships: the directories under `skills/`.
 *
 * Discovered rather than listed, for the same reason the manifests point at
 * the whole directory: an agent that reads `skills/` through a manifest gets
 * every skill in it, and the agents that get copies should not get fewer.
 */
export function shippedSkills(root) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, "skills"), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Every file this agent should end up with, keyed by its path under the agent's
 * home. Copied bytes and rendered commands go through the same map, so
 * `--check` reports staleness for both without knowing the difference.
 *
 * Commands are a plugin's rather than a skill's, and they reach into the skills
 * beside them, so a plugin only gets its command namespace when all of its
 * skills are being installed. A menu entry naming a file that was never copied
 * fails at the moment somebody runs it.
 */
export function plannedFiles(installs, target, agentHome = "") {
  const planned = new Map();

  for (const install of installs) {
    for (const skill of install.skills) {
      const source = path.join(install.root, "skills", skill);
      for (const relative of filesUnder(source)) {
        planned.set(
          path.join(target.skills, skill, relative),
          fs.readFileSync(path.join(source, relative)),
        );
      }
    }

    const commands = path.join(install.root, "commands");
    if (!target.commands || !install.complete || !fs.existsSync(commands)) {
      continue;
    }
    for (const entry of fs.readdirSync(commands)) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      planned.set(
        path.join(
          target.commands,
          install.name,
          `${path.basename(entry, ".md")}.toml`,
        ),
        Buffer.from(
          renderGeminiCommand(
            fs.readFileSync(path.join(commands, entry), "utf8"),
            { skills: path.join(agentHome, target.skills) },
          ),
        ),
      );
    }
  }

  return planned;
}

/**
 * The checkout this script ships in.
 *
 * Not the working directory: the useful way to run this is straight out of a
 * global install - `node "$(npm root -g)/@releasetools/mutex/scripts/install-agent-skills.mjs"` -
 * from wherever the user happens to be standing.
 */
export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The plugins a tree ships, in either of the two homes this script has.
 *
 * In this repository each one is a directory under `plugins/`, which is the
 * thing published. In an npm package that carries a plugin, `skills/` and
 * `commands/` sit at the top level, because the release copies them there so
 * that a global install can seed the agents that read no manifest and have no
 * checkout. The package directory is the plugin's name there, which is what
 * Gemini's command namespace is built from.
 *
 * Discovered rather than listed, so a plugin added to `plugins/` reaches these
 * agents the same day it reaches the two that read a manifest.
 */
export function shippedPlugins(here = PACKAGE_ROOT) {
  const directory = path.join(here, "plugins");
  let names = [];
  try {
    names = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    names = [];
  }

  const inTree = names
    .map((name) => ({ name, root: path.join(directory, name) }))
    .filter((plugin) => fs.existsSync(path.join(plugin.root, "skills")));
  if (inTree.length > 0) {
    return inTree;
  }

  return fs.existsSync(path.join(here, "skills"))
    ? [{ name: path.basename(here), root: here }]
    : [];
}

/**
 * What each plugin contributes, once `--plugin` and `--skill` have had their
 * say.
 *
 * A plugin whose skills are only partly selected is marked incomplete, which
 * is what withholds its commands.
 */
function selected(available, plugins, skills) {
  return available
    .filter((plugin) => plugins.length === 0 || plugins.includes(plugin.name))
    .map((plugin) => {
      const all = shippedSkills(plugin.root);
      const wanted =
        skills.length === 0 ? all : all.filter((name) => skills.includes(name));
      return {
        ...plugin,
        skills: wanted,
        complete: wanted.length === all.length,
      };
    })
    .filter((plugin) => plugin.skills.length > 0);
}

/**
 * Two plugins cannot both call a skill `naming`.
 *
 * Every agent here reads one flat skills directory, so the second copy would
 * overwrite the first and the loser would be whichever sorted earlier. Both
 * agents would then follow instructions from a plugin they did not install.
 */
function refuseCollisions(installs) {
  const claimed = new Map();
  for (const install of installs) {
    for (const skill of install.skills) {
      const owner = claimed.get(skill);
      if (owner && owner !== install.name) {
        throw new Error(
          `${owner} and ${install.name} both ship a skill called '${skill}', and ` +
            "these agents read one flat directory. Rename one before installing both.",
        );
      }
      claimed.set(skill, install.name);
    }
  }
}

export function installAgentSkills(options = {}) {
  const root = options.root ?? PACKAGE_ROOT;
  const home = options.home ?? os.homedir();
  const requested = options.targets?.length ? options.targets : DEFAULT_TARGETS;
  const write = !options.check && !options.dryRun;

  const unknown = requested.filter(
    (name) => !TARGETS.some((target) => target.agent === name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `unknown agent(s): ${unknown.join(", ")}. Known: ${TARGETS.map(({ agent }) => agent).join(", ")}`,
    );
  }

  const available = shippedPlugins(root);
  if (available.length === 0) {
    throw new Error(`no plugins to install under ${root}`);
  }

  const wantedPlugins = options.plugins ?? [];
  const missingPlugins = wantedPlugins.filter(
    (name) => !available.some((plugin) => plugin.name === name),
  );
  if (missingPlugins.length > 0) {
    throw new Error(
      `unknown plugin(s): ${missingPlugins.join(", ")}. Here: ${available.map(({ name }) => name).join(", ")}`,
    );
  }

  const wantedSkills = options.skills ?? [];
  const installs = selected(available, wantedPlugins, wantedSkills);
  const skills = [
    ...new Set(installs.flatMap((install) => install.skills)),
  ].sort();

  const missingSkills = wantedSkills.filter((name) => !skills.includes(name));
  if (missingSkills.length > 0) {
    throw new Error(
      `no skill to install called ${missingSkills.join(", ")}. Here: ${available
        .flatMap((plugin) => shippedSkills(plugin.root))
        .sort()
        .join(", ")}`,
    );
  }
  if (skills.length === 0) {
    throw new Error(`no skills to install under ${root}`);
  }
  refuseCollisions(installs);

  const results = [];

  for (const target of TARGETS.filter((candidate) =>
    requested.includes(candidate.agent),
  )) {
    const agentHome = path.join(home, target.home);
    const destination = path.join(agentHome, target.skills);

    if (!fs.existsSync(agentHome)) {
      // Not installed here. Creating the directory would leave a skill for an
      // agent that will never read it, in a home that agent did not create.
      results.push({
        agent: target.agent,
        path: destination,
        status: "absent",
      });
      continue;
    }

    const planned = plannedFiles(installs, target, agentHome);
    const changed = [...planned]
      .filter(([relative, contents]) => {
        try {
          return !fs
            .readFileSync(path.join(agentHome, relative))
            .equals(contents);
        } catch {
          return true;
        }
      })
      .map(([relative]) => relative);

    const status = skills.some(
      (skill) => !fs.existsSync(path.join(destination, skill)),
    )
      ? "missing"
      : changed.length > 0
        ? "stale"
        : "current";

    if (write) {
      for (const relative of changed) {
        const file = path.join(agentHome, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, planned.get(relative));
      }
    }

    // Files an earlier layout left behind. Reported rather than deleted, since
    // this writes into directories it does not own.
    const roots = [
      ...skills.map((skill) => path.join(target.skills, skill)),
      ...(target.commands
        ? installs
            .filter((install) => install.complete)
            .map((install) => path.join(target.commands, install.name))
        : []),
    ];
    const extra = roots
      .filter((relative) => fs.existsSync(path.join(agentHome, relative)))
      .flatMap((relative) =>
        filesUnder(path.join(agentHome, relative))
          .map((found) => path.join(relative, found))
          .filter((found) => !planned.has(found)),
      );

    results.push({
      agent: target.agent,
      path: destination,
      status: write && changed.length > 0 ? "written" : status,
      changed,
      extra,
      note: target.note,
    });
  }

  return {
    plugins: installs.map(({ name, root: at, skills: shipped }) => ({
      name,
      root: at,
      skills: shipped,
    })),
    skills,
    results,
  };
}

// Run directly, rather than imported by a test.
if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  const { values } = parseArgs({
    options: {
      target: { type: "string", multiple: true, short: "t" },
      plugin: { type: "string", multiple: true, short: "p" },
      skill: { type: "string", multiple: true },
      check: { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(
      `install-agent-skills - copy skills/ into each agent's skills directory\n\n` +
        `Usage: node scripts/install-agent-skills.mjs [options]\n\n` +
        `Options:\n` +
        `  -t, --target <agent>  Repeatable. ${TARGETS.map(({ agent }) => agent).join(", ")}\n` +
        `                        (default: ${DEFAULT_TARGETS.join(", ")})\n` +
        `  -p, --plugin <name>   Repeatable. Which plugins to install\n` +
        `                        (default: every plugin in this tree)\n` +
        `      --skill <name>    Repeatable. Which of their skills to install.\n` +
        `                        A plugin only gets its commands when all of\n` +
        `                        its skills are installed\n` +
        `      --check           Report what is missing or stale, and change nothing\n` +
        `      --dry-run         Report what would be written, and change nothing\n` +
        `  -h, --help            Show this\n\n` +
        `Claude Code and Codex read skills/ through their own manifests, so they are\n` +
        `only touched when named with --target.\n`,
    );
    process.exit(0);
  }

  try {
    const split = (given) =>
      (given ?? []).flatMap((value) =>
        value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      );
    const { plugins, results } = installAgentSkills({
      targets: split(values.target),
      plugins: split(values.plugin),
      skills: split(values.skill),
      check: values.check,
      dryRun: values["dry-run"],
    });

    for (const plugin of plugins) {
      process.stdout.write(
        `Source: ${plugin.root}  (${plugin.skills.join(", ")})\n`,
      );
    }
    for (const result of results) {
      const detail =
        result.status === "absent"
          ? "agent not installed here"
          : result.status === "current"
            ? "up to date"
            : `${result.changed.length} file(s)`;
      process.stdout.write(
        `  ${result.agent.padEnd(7)} ${result.status.padEnd(8)} ${result.path}  (${detail})\n`,
      );
      for (const extra of result.extra ?? []) {
        process.stdout.write(`      leftover, not removed: ${extra}\n`);
      }
      if (result.note) {
        process.stdout.write(`      ${result.note}\n`);
      }
    }

    if (
      values.check &&
      results.some(
        (result) => result.status === "missing" || result.status === "stale",
      )
    ) {
      process.exit(1);
    }
  } catch (error) {
    process.stderr.write(`install-agent-skills: ${error.message}\n`);
    process.exit(1);
  }
}
