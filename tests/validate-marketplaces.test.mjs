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
import { validateMarketplaces } from "../scripts/validate-marketplaces.mjs";
import {
  assembled,
  marketplace,
  readJson,
  write,
  writeJson,
} from "./fixtures.mjs";

/**
 * Neither client validates the other's catalog, and this repository is only
 * useful when both say the same thing. Every case below is a marketplace that
 * one of the two vendors would accept on its own.
 */

const CLAUDE = ".claude-plugin/marketplace.json";
const CODEX = ".agents/plugins/marketplace.json";

/** Two published plugins, which is the smallest interesting marketplace. */
function published() {
  const root = marketplace();
  publishPlugin({ root, plugin: assembled("mutex", { version: "0.1.0" }) });
  publishPlugin({ root, plugin: assembled("scaffold", { version: "2.3.4" }) });
  return root;
}

const failure = (root) => validateMarketplaces({ root }).errors.join("\n");

test("passes on what the publisher wrote", () => {
  const root = published();
  assert.deepEqual(validateMarketplaces({ root }), {
    plugins: ["mutex", "scaffold"],
    errors: [],
  });
});

test("passes on an empty marketplace", () => {
  assert.deepEqual(validateMarketplaces({ root: marketplace() }), {
    plugins: [],
    errors: [],
  });
});

test("catches catalogs that list different plugins", () => {
  const root = published();
  const codex = readJson(root, CODEX);
  codex.plugins.pop();
  writeJson(root, CODEX, codex);

  assert.match(failure(root), /list different plugins/);
});

test("catches catalogs that list the same plugins in a different order", () => {
  const root = published();
  const codex = readJson(root, CODEX);
  codex.plugins.reverse();
  writeJson(root, CODEX, codex);

  assert.match(failure(root), /list different plugins/);
});

test("catches a catalog version that is not the plugin's version", () => {
  const root = published();
  const claude = readJson(root, CLAUDE);
  claude.plugins[0].version = "9.9.9";
  writeJson(root, CLAUDE, claude);

  assert.match(failure(root), /lists mutex 9\.9\.9, but the plugin is 0\.1\.0/);
});

test("catches manifests inside one plugin that disagree", () => {
  const root = published();
  const manifest = readJson(root, "plugins/mutex/.codex-plugin/plugin.json");
  manifest.version = "0.9.0";
  writeJson(root, "plugins/mutex/.codex-plugin/plugin.json", manifest);

  assert.match(failure(root), /carries two versions/);
});

test("catches a source pointing outside plugins/", () => {
  const root = published();
  const claude = readJson(root, CLAUDE);
  claude.plugins[0].source = "./plugins/../../elsewhere";
  writeJson(root, CLAUDE, claude);

  assert.match(failure(root), /points outside plugins\//);
});

test("catches a duplicated plugin name", () => {
  const root = published();
  const claude = readJson(root, CLAUDE);
  claude.plugins.push({ ...claude.plugins[0] });
  writeJson(root, CLAUDE, claude);

  assert.match(failure(root), /lists 'mutex' twice/);
});

test("catches a catalog entry with no plugin behind it", () => {
  const root = published();
  fs.rmSync(path.join(root, "plugins/mutex"), { recursive: true });

  assert.match(failure(root), /in both catalogs but not in the repository/);
});

test("catches a plugin directory that is in neither catalog", () => {
  const root = published();
  fs.cpSync(
    path.join(root, "plugins/mutex"),
    path.join(root, "plugins/stowaway"),
    {
      recursive: true,
    },
  );

  assert.match(
    failure(root),
    /plugins\/stowaway\/ is in the repository but in neither catalog/,
  );
});

test("catches a symlink in a published plugin", () => {
  const root = published();
  fs.symlinkSync(
    "/etc/passwd",
    path.join(root, "plugins/mutex/skills/leak.md"),
  );

  assert.match(failure(root), /no symlinks/);
});

test("catches files that have no business being published", () => {
  const root = published();
  write(
    root,
    "plugins/mutex/.env",
    "MUTEX_DATABASE_URL=postgres://localhost/db\n",
  );
  write(root, "plugins/scaffold/deploy.pem", "irrelevant\n");

  const errors = failure(root);
  assert.match(errors, /plugins\/mutex\/\.env does not belong/);
  assert.match(errors, /plugins\/scaffold\/deploy\.pem does not belong/);
});

test("catches a secret that arrived inside an ordinary file", () => {
  const root = published();
  write(
    root,
    "plugins/mutex/skills/mutex/reference.md",
    "Try `MUTEX_DATABASE_URL=postgres://mutex:hunter2@db.example.com/locks`\n",
  );
  write(
    root,
    "plugins/scaffold/README.md",
    "-----BEGIN OPENSSH PRIVATE KEY-----\n",
  );

  const errors = failure(root);
  assert.match(errors, /connection string with a password/);
  assert.match(errors, /a private key/);
});

test("does not mistake a documented placeholder for a secret", () => {
  const root = published();
  write(
    root,
    "plugins/mutex/README.md",
    'MUTEX_DATABASE_URL="postgres://..." mutex lock staging\n',
  );

  assert.deepEqual(validateMarketplaces({ root }).errors, []);
});

test("catches a catalog somebody reformatted by hand", () => {
  const root = published();
  fs.writeFileSync(
    path.join(root, CODEX),
    JSON.stringify(readJson(root, CODEX)),
  );

  assert.match(failure(root), /not in the form the publisher writes/);
});

test("catches a marketplace renamed out from under its users", () => {
  const root = published();
  const claude = readJson(root, CLAUDE);
  claude.name = "releasetools-plugins";
  writeJson(root, CLAUDE, claude);

  assert.match(failure(root), /names the marketplace 'releasetools-plugins'/);
});

test("catches a Codex entry with no installation policy", () => {
  const root = published();
  const codex = readJson(root, CODEX);
  delete codex.plugins[0].policy;
  writeJson(root, CODEX, codex);

  assert.match(failure(root), /no installation and authentication policy/);
});

test("catches metadata that only the catalog knows about", () => {
  const root = published();
  const claude = readJson(root, CLAUDE);
  claude.plugins[0].description = "written straight into the catalog";
  writeJson(root, CLAUDE, claude);

  assert.match(failure(root), /is not what the publisher generates/);
});

test("catches a category changed in the catalog rather than the manifest", () => {
  const root = published();
  const codex = readJson(root, CODEX);
  codex.plugins[0].category = "Productivity";
  writeJson(root, CODEX, codex);

  assert.match(failure(root), /is not what the publisher generates/);
});
