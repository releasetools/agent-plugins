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
import path from "node:path";
import { parseArgs } from "node:util";
import {
  CLAUDE_CATALOG,
  CLAUDE_MANIFEST,
  CODEX_CATALOG,
  CODEX_MANIFEST,
  MARKETPLACE_NAME,
  PLUGINS_DIR,
  PLUGIN_NAME,
  SEMVER,
  claudeEntry,
  codexEntry,
  compareVersions,
  listTree,
  readJson,
  serializeJson,
  writeJson,
} from "./catalogs.mjs";

/**
 * Puts an assembled plugin into this marketplace, in both clients' catalogs.
 *
 *     node scripts/publish-plugin.mjs --plugin /tmp/mutex-plugin
 *
 * A plugin's own repository owns its source, its tests and its version; this
 * repository owns the catalogs and holds a copy of what was published. So this
 * is a file transformation with no judgement in it, and deliberately no
 * network, no dependencies and no package manager: it is run by the job that
 * holds a cross-repository write token, and everything that job can execute is
 * something an attacker would like to be able to execute.
 *
 * The rules it will not bend on:
 *
 * - a version already published is immutable, because somebody has installed
 *   it and a plugin that changes underneath its version number is a plugin
 *   nobody can reason about;
 * - a version cannot go backwards, because clients compare versions to decide
 *   whether an update exists;
 * - every other plugin in both catalogs comes out exactly as it went in.
 *
 * `--allow-republish` is the recovery path for the two refusals, and it is
 * meant to be typed by a person who has decided the release was wrong.
 */

export function publishPlugin({
  root = process.cwd(),
  plugin,
  allowRepublish = false,
}) {
  const marketplace = path.resolve(root);
  const source = path.resolve(plugin);

  const { name, version, claude, codex } = describe(source);
  const target = path.join(marketplace, PLUGINS_DIR, name);
  if (target === source) {
    throw new Error(
      "--plugin is the published copy itself; publish from an assembled directory",
    );
  }

  const catalogs = {
    claude: loadCatalog(marketplace, CLAUDE_CATALOG),
    codex: loadCatalog(marketplace, CODEX_CATALOG),
  };

  const entries = { claude: claudeEntry(claude), codex: codexEntry(codex) };

  const previousVersion = publishedVersion(target);
  if (previousVersion !== null) {
    const order = compareVersions(version, previousVersion);
    if (order < 0 && !allowRepublish) {
      throw new Error(
        `refusing to publish ${name} ${version} over ${previousVersion}: ` +
          "a published version cannot go backwards. Pass --allow-republish if that is the intent.",
      );
    }
    if (order === 0) {
      const changed = changedFiles(source, target);
      if (changed.length > 0 && !allowRepublish) {
        throw new Error(
          `refusing to republish ${name} ${version} with different contents ` +
            `(${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", …" : ""}): ` +
            "bump the plugin version, or pass --allow-republish to replace a release that was wrong.",
        );
      }
      if (changed.length === 0 && catalogedAs(catalogs, name, entries)) {
        return {
          status: "unchanged",
          name,
          version,
          previousVersion,
          changed: [],
        };
      }
    }
  }

  replaceTree(source, target);
  for (const [client, catalog] of Object.entries(catalogs)) {
    catalog.value.plugins = upsert(catalog.value.plugins, entries[client]);
    writeJson(catalog.file, catalog.value);
  }

  return {
    status: "published",
    name,
    version,
    previousVersion,
    files: listTree(target),
  };
}

/** Reads the assembled plugin's two manifests, and refuses to guess. */
function describe(source) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`${source} is not a directory`);
  }

  const manifests = {};
  for (const [client, relative] of [
    ["claude", CLAUDE_MANIFEST],
    ["codex", CODEX_MANIFEST],
  ]) {
    const file = path.join(source, relative);
    if (!fs.existsSync(file)) {
      throw new Error(
        `${relative} is missing; this is not an assembled plugin`,
      );
    }
    manifests[client] = readJson(file);
  }

  const { claude, codex } = manifests;
  if (claude.name !== codex.name) {
    throw new Error(
      `the manifests name different plugins: ${claude.name} and ${codex.name}`,
    );
  }
  if (claude.version !== codex.version) {
    throw new Error(
      `the manifests carry different versions: ${claude.version} and ${codex.version}`,
    );
  }
  if (typeof claude.name !== "string" || !PLUGIN_NAME.test(claude.name)) {
    throw new Error(`'${claude.name}' is not a usable plugin name`);
  }
  if (typeof claude.version !== "string" || !SEMVER.test(claude.version)) {
    throw new Error(`'${claude.version}' is not strict X.Y.Z semver`);
  }
  if (
    typeof claude.description !== "string" ||
    claude.description.trim() === ""
  ) {
    throw new Error(`${CLAUDE_MANIFEST} has no description`);
  }
  const category = codex.interface?.category;
  if (typeof category !== "string" || category.trim() === "") {
    throw new Error(`${CODEX_MANIFEST} has no interface.category`);
  }

  // Nothing here should ever be a symlink, and finding out after the copy is
  // finding out too late.
  listTree(source);

  return { name: claude.name, version: claude.version, claude, codex };
}

function loadCatalog(marketplace, relative) {
  const file = path.join(marketplace, relative);
  if (!fs.existsSync(file)) {
    throw new Error(
      `${relative} is missing; is ${marketplace} the marketplace?`,
    );
  }
  const value = readJson(file);
  if (value.name !== MARKETPLACE_NAME) {
    throw new Error(
      `${relative} is the '${value.name}' marketplace, not '${MARKETPLACE_NAME}'`,
    );
  }
  if (!Array.isArray(value.plugins)) {
    throw new Error(`${relative} has no plugins array`);
  }
  return { file, value };
}

/** Replaces an entry where it stands, or appends. Order is never reshuffled. */
function upsert(plugins, entry) {
  const index = plugins.findIndex((existing) => existing?.name === entry.name);
  if (index < 0) {
    return [...plugins, entry];
  }
  const copy = [...plugins];
  copy[index] = entry;
  return copy;
}

function catalogedAs(catalogs, name, entries) {
  return Object.entries(catalogs).every(([client, catalog]) => {
    const existing = catalog.value.plugins.find(
      (entry) => entry?.name === name,
    );
    return (
      existing && serializeJson(existing) === serializeJson(entries[client])
    );
  });
}

function publishedVersion(target) {
  const manifest = path.join(target, CLAUDE_MANIFEST);
  if (!fs.existsSync(manifest)) {
    return null;
  }
  return readJson(manifest).version ?? null;
}

/** Which files differ between what was published and what is being published. */
function changedFiles(source, target) {
  const before = new Set(listTree(target));
  const after = new Set(listTree(source));
  const changed = [];
  for (const file of new Set([...before, ...after])) {
    if (!before.has(file) || !after.has(file)) {
      changed.push(file);
      continue;
    }
    const left = fs.readFileSync(path.join(target, file));
    const right = fs.readFileSync(path.join(source, file));
    if (!left.equals(right)) {
      changed.push(file);
    }
  }
  return changed.sort();
}

/**
 * Replaces `plugins/<name>/` wholesale.
 *
 * Copying over the top would leave behind whatever the previous version had and
 * this one dropped - a command that was withdrawn, a skill that was renamed -
 * and an agent reads every file it finds, so a leftover is not inert.
 */
function replaceTree(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  for (const file of listTree(source)) {
    const destination = path.join(target, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, file), destination);
  }
}

// Run directly, rather than imported by a test.
if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  const { values } = parseArgs({
    options: {
      plugin: { type: "string" },
      root: { type: "string" },
      "allow-republish": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });

  if (!values.plugin) {
    process.stderr.write(
      "publish-plugin: --plugin <assembled plugin directory> is required\n",
    );
    process.exit(2);
  }

  try {
    const result = publishPlugin({
      root: values.root,
      plugin: values.plugin,
      allowRepublish: values["allow-republish"],
    });
    if (values.json) {
      process.stdout.write(serializeJson(result));
    } else if (result.status === "unchanged") {
      process.stdout.write(
        `${result.name} ${result.version} is already published, unchanged. Nothing to do.\n`,
      );
    } else {
      const from = result.previousVersion
        ? ` (was ${result.previousVersion})`
        : " (new plugin)";
      process.stdout.write(
        `Published ${result.name} ${result.version}${from}\n`,
      );
      for (const file of result.files) {
        process.stdout.write(`  ${PLUGINS_DIR}/${result.name}/${file}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`publish-plugin: ${error.message}\n`);
    process.exit(1);
  }
}
