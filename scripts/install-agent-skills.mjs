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
 * Puts the skills where each agent looks for them.
 *
 * Claude Code and Codex read `skills/` through the manifests in
 * `.claude-plugin/` and `.codex-plugin/`, so they install the plugin rather
 * than a copy and are not touched unless asked for by name. The rest have no
 * manifest to read: they discover skills by walking a directory under their own
 * home, so the directory has to be there.
 *
 * Copies rather than symlinks. A symlink into a git worktree turns "I deleted
 * that branch" into "my agent lost a skill", and these directories outlive the
 * checkouts they came from.
 */

/**
 * The skill the slash commands invoke their helper from. The commands are the
 * plugin's rather than any one skill's, so they render into this namespace and
 * only when this skill is being installed - a command naming a helper that was
 * not copied would fail at the moment it runs.
 */
const PLUGIN_SKILL = "mutex";

export const TARGETS = [
  {
    agent: "hermes",
    home: ".hermes",
    // Hermes groups skills by category; mutex belongs with the devops ones.
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
    note: "Antigravity reads the same directory",
  },
  {
    agent: "claude",
    home: ".claude",
    skills: "skills",
    manifest:
      "install the plugin instead: /plugin marketplace add releasetools/mutex",
  },
  {
    agent: "codex",
    home: ".codex",
    skills: "skills",
    manifest: "install the plugin instead: codex plugin add mutex",
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
 * to `{{args}}`, `!`cmd`` to `!{cmd}`, and the plugin root to the path the
 * skill lands at - is what stops the two from drifting into different
 * instructions.
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
    .replaceAll(
      "${CLAUDE_PLUGIN_ROOT}/skills/" + (options.skill ?? "mutex"),
      options.skillDir ?? ".",
    )
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
 */
export function plannedFiles(root, skills, target, agentHome = "") {
  const planned = new Map();

  for (const skill of skills) {
    const source = path.join(root, "skills", skill);
    for (const relative of filesUnder(source)) {
      planned.set(
        path.join(target.skills, skill, relative),
        fs.readFileSync(path.join(source, relative)),
      );
    }
  }

  const commands = path.join(root, "commands");
  if (
    target.commands &&
    skills.includes(PLUGIN_SKILL) &&
    fs.existsSync(commands)
  ) {
    for (const entry of fs.readdirSync(commands)) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      planned.set(
        path.join(
          target.commands,
          PLUGIN_SKILL,
          `${path.basename(entry, ".md")}.toml`,
        ),
        Buffer.from(
          renderGeminiCommand(
            fs.readFileSync(path.join(commands, entry), "utf8"),
            {
              skill: PLUGIN_SKILL,
              skillDir: path.join(agentHome, target.skills, PLUGIN_SKILL),
            },
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
 * Where `skills/` and `commands/` are, in either of the two homes this has.
 *
 * In this repository they sit inside `plugins/<name>/`, which is the thing
 * published. In the mutex npm package they sit at the top level, because the
 * release copies them there so that a global install can seed the agents that
 * read no manifest and have no checkout. One script, because the alternative is
 * two that drift.
 */
export function defaultRoot(here = PACKAGE_ROOT, plugin = PLUGIN_SKILL) {
  const inTree = path.join(here, "plugins", plugin);
  if (fs.existsSync(path.join(inTree, "skills"))) {
    return inTree;
  }
  return here;
}

export function installAgentSkills(options = {}) {
  const root = options.root ?? defaultRoot(PACKAGE_ROOT);
  const home = options.home ?? os.homedir();
  const skills = options.skills?.length ? options.skills : shippedSkills(root);
  const source = path.join(root, "skills");
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
  if (skills.length === 0) {
    throw new Error(`no skills to install under ${source}`);
  }
  for (const skill of skills) {
    if (!fs.existsSync(path.join(source, skill))) {
      throw new Error(`no skill to install at ${path.join(source, skill)}`);
    }
  }

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

    const planned = plannedFiles(root, skills, target, agentHome);
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
      ...(target.commands && skills.includes(PLUGIN_SKILL)
        ? [path.join(target.commands, PLUGIN_SKILL)]
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

  return { source, skills, results };
}

// Run directly, rather than imported by a test.
if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  const { values } = parseArgs({
    options: {
      target: { type: "string", multiple: true, short: "t" },
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
        `      --skill <name>    Repeatable. Which skills to install\n` +
        `                        (default: every directory under skills/)\n` +
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
    const { source, results } = installAgentSkills({
      targets: split(values.target),
      skills: split(values.skill),
      check: values.check,
      dryRun: values["dry-run"],
    });

    process.stdout.write(`Source: ${source}\n`);
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
