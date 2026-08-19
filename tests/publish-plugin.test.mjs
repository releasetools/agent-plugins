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

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { publishPlugin } from "../scripts/publish-plugin.mjs";
import { assembled, marketplace, readJson, writeJson } from "./fixtures.mjs";

/**
 * A publication is one plugin's release and every other plugin's ordinary
 * Tuesday. What these check is mostly the second half: that mutex arriving does
 * not move, rewrite or drop anything that was already published, and that a
 * version somebody has already installed cannot change underneath them.
 */

const names = (root, catalog) =>
  readJson(root, catalog).plugins.map((entry) => entry.name);
/** Two published plugins, which is the smallest interesting marketplace. */
function published() {
  const root = marketplace();
  publishPlugin({ root, plugin: assembled("mutex", { version: "0.1.0" }) });
  publishPlugin({ root, plugin: assembled("scaffold", { version: "2.3.4" }) });
  return root;
}

const CLAUDE = ".claude-plugin/marketplace.json";
const CODEX = ".agents/plugins/marketplace.json";

test("publishes a plugin into both catalogs", () => {
  const root = marketplace();
  const result = publishPlugin({
    root,
    plugin: assembled("mutex", { version: "0.1.0" }),
  });

  assert.deepEqual(
    {
      status: result.status,
      version: result.version,
      previousVersion: result.previousVersion,
    },
    { status: "published", version: "0.1.0", previousVersion: null },
  );
  assert.ok(
    fs.existsSync(path.join(root, "plugins/mutex/skills/mutex/SKILL.md")),
  );

  const claude = readJson(root, CLAUDE).plugins[0];
  assert.equal(claude.source, "./plugins/mutex");
  assert.equal(claude.version, "0.1.0");
  assert.equal(claude.license, "Apache-2.0");

  const codex = readJson(root, CODEX).plugins[0];
  assert.deepEqual(codex.source, { source: "local", path: "./plugins/mutex" });
  assert.deepEqual(codex.policy, {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
  });
  assert.equal(codex.category, "Developer Tools");
  assert.equal(
    "version" in codex,
    false,
    "Codex reads the version from the plugin manifest",
  );
});

test("appends a second plugin without disturbing the first", () => {
  const root = marketplace();
  publishPlugin({ root, plugin: assembled("mutex", { version: "0.1.0" }) });
  const before = readJson(root, CLAUDE).plugins[0];

  publishPlugin({ root, plugin: assembled("scaffold", { version: "2.3.4" }) });

  assert.deepEqual(names(root, CLAUDE), ["mutex", "scaffold"]);
  assert.deepEqual(names(root, CODEX), ["mutex", "scaffold"]);
  assert.deepEqual(readJson(root, CLAUDE).plugins[0], before);
  assert.ok(
    fs.existsSync(path.join(root, "plugins/mutex/skills/mutex/SKILL.md")),
  );
});

test("upgrading keeps a plugin where it already was in the order", () => {
  const root = marketplace();
  publishPlugin({ root, plugin: assembled("mutex", { version: "0.1.0" }) });
  publishPlugin({ root, plugin: assembled("scaffold", { version: "2.3.4" }) });
  const scaffold = readJson(root, CLAUDE).plugins[1];

  publishPlugin({ root, plugin: assembled("mutex", { version: "0.2.0" }) });

  assert.deepEqual(names(root, CLAUDE), ["mutex", "scaffold"]);
  assert.deepEqual(names(root, CODEX), ["mutex", "scaffold"]);
  assert.equal(readJson(root, CLAUDE).plugins[0].version, "0.2.0");
  assert.deepEqual(readJson(root, CLAUDE).plugins[1], scaffold);
});

test("a new version drops the files the old one had", () => {
  const root = marketplace();
  publishPlugin({
    root,
    plugin: assembled("mutex", {
      version: "0.1.0",
      files: { "commands/withdrawn.md": "gone\n" },
    }),
  });
  assert.ok(
    fs.existsSync(path.join(root, "plugins/mutex/commands/withdrawn.md")),
  );

  publishPlugin({ root, plugin: assembled("mutex", { version: "0.2.0" }) });

  assert.equal(
    fs.existsSync(path.join(root, "plugins/mutex/commands/withdrawn.md")),
    false,
  );
});

test("republishing the same version unchanged does nothing at all", () => {
  const root = marketplace();
  publishPlugin({ root, plugin: assembled("mutex", { version: "0.1.0" }) });
  const catalog = fs.readFileSync(path.join(root, CLAUDE));

  const result = publishPlugin({
    root,
    plugin: assembled("mutex", { version: "0.1.0" }),
  });

  assert.equal(result.status, "unchanged");
  assert.deepEqual(fs.readFileSync(path.join(root, CLAUDE)), catalog);
});

test("refuses to change the contents of a published version", () => {
  const root = marketplace();
  publishPlugin({ root, plugin: assembled("mutex", { version: "0.1.0" }) });
  const changed = assembled("mutex", {
    version: "0.1.0",
    files: { "README.md": "# different\n" },
  });

  assert.throws(
    () => publishPlugin({ root, plugin: changed }),
    /different contents/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "plugins/mutex/README.md"), "utf8"),
    "# mutex\n",
  );

  const recovered = publishPlugin({
    root,
    plugin: changed,
    allowRepublish: true,
  });
  assert.equal(recovered.status, "published");
  assert.equal(
    fs.readFileSync(path.join(root, "plugins/mutex/README.md"), "utf8"),
    "# different\n",
  );
});

test("refuses a version that goes backwards", () => {
  const root = marketplace();
  publishPlugin({ root, plugin: assembled("mutex", { version: "0.2.0" }) });

  assert.throws(
    () =>
      publishPlugin({ root, plugin: assembled("mutex", { version: "0.1.9" }) }),
    /cannot go backwards/,
  );
  assert.equal(readJson(root, CLAUDE).plugins[0].version, "0.2.0");

  publishPlugin({
    root,
    plugin: assembled("mutex", { version: "0.1.9" }),
    allowRepublish: true,
  });
  assert.equal(readJson(root, CLAUDE).plugins[0].version, "0.1.9");
});

test("refuses manifests that disagree", () => {
  const root = marketplace();
  assert.throws(
    () =>
      publishPlugin({
        root,
        plugin: assembled("mutex", { codex: { version: "9.9.9" } }),
      }),
    /different versions/,
  );
  assert.throws(
    () =>
      publishPlugin({
        root,
        plugin: assembled("mutex", { codex: { name: "other" } }),
      }),
    /different plugins/,
  );
  assert.throws(
    () =>
      publishPlugin({ root, plugin: assembled("mutex", { version: "1.0" }) }),
    /strict X\.Y\.Z semver/,
  );
  assert.equal(readJson(root, CLAUDE).plugins.length, 0);
});

test("refuses a plugin with no category for Codex to file it under", () => {
  const root = marketplace();
  assert.throws(
    () =>
      publishPlugin({
        root,
        plugin: assembled("mutex", { codex: { interface: {} } }),
      }),
    /interface\.category/,
  );
});

test("refuses a name that is not one path segment", () => {
  const root = marketplace();
  for (const name of ["../escape", "Upper", "a/b"]) {
    const plugin = assembled("safe", { claude: { name }, codex: { name } });
    assert.throws(() => publishPlugin({ root, plugin }), /usable plugin name/);
  }
});

test("refuses a symlink rather than publishing one", () => {
  const root = marketplace();
  const plugin = assembled("mutex");
  fs.symlinkSync("/etc/passwd", path.join(plugin, "skills/mutex/leak.md"));

  assert.throws(() => publishPlugin({ root, plugin }), /not a regular file/);
  assert.equal(fs.existsSync(path.join(root, "plugins/mutex")), false);
});

test("refuses a checkout that is not this marketplace", () => {
  const root = marketplace({ name: "someone-else" });
  assert.throws(
    () => publishPlugin({ root, plugin: assembled("mutex") }),
    /not 'releasetools'/,
  );
});

test("writes the JSON a formatter would leave alone", () => {
  const root = marketplace();
  publishPlugin({ root, plugin: assembled("mutex", { version: "0.1.0" }) });

  for (const catalog of [CLAUDE, CODEX]) {
    const text = fs.readFileSync(path.join(root, catalog), "utf8");
    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  }
});

test("repairs a catalog entry that was edited by hand", () => {
  const root = marketplace();
  publishPlugin({ root, plugin: assembled("mutex", { version: "0.1.0" }) });

  const catalog = readJson(root, CLAUDE);
  catalog.plugins[0].description = "edited by somebody";
  writeJson(root, CLAUDE, catalog);

  const result = publishPlugin({
    root,
    plugin: assembled("mutex", { version: "0.1.0" }),
  });

  assert.equal(result.status, "published");
  assert.equal(
    readJson(root, CLAUDE).plugins[0].description,
    "The mutex plugin",
  );
});

test("refuses a directory that is not an assembled plugin", () => {
  const root = marketplace();
  const plugin = assembled("mutex");
  fs.rmSync(path.join(plugin, ".codex-plugin/plugin.json"));

  assert.throws(
    () => publishPlugin({ root, plugin }),
    /\.codex-plugin\/plugin\.json is missing/,
  );
});

test("refuses to publish the already-published copy onto itself", () => {
  const root = published();
  const plugin = path.join(root, "plugins/mutex");

  assert.throws(
    () => publishPlugin({ root, plugin }),
    /the published copy itself/,
  );
  assert.ok(fs.existsSync(path.join(plugin, "skills/mutex/SKILL.md")));
});
