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

/**
 * Throwaway marketplaces and assembled plugins.
 *
 * Every test that matters here is about a second plugin: whether publishing one
 * disturbs another's entry, its position, or its files. So the fixtures make it
 * cheap to have two.
 */

export function temporary(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
}

export function write(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

export function writeJson(root, relative, value) {
  return write(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

/** An empty marketplace, as this repository looked before its first plugin. */
export function marketplace(overrides = {}) {
  const root = temporary("marketplace");
  writeJson(root, ".claude-plugin/marketplace.json", {
    name: overrides.name ?? "releasetools",
    owner: { name: "releasetools" },
    description: "Official releasetools plugins for coding agents",
    plugins: [],
  });
  writeJson(root, ".agents/plugins/marketplace.json", {
    name: overrides.name ?? "releasetools",
    interface: { displayName: "releasetools" },
    plugins: [],
  });
  return root;
}

/** A plugin as `npm run plugin:package` leaves it in its own repository. */
export function assembled(name, overrides = {}) {
  const root = overrides.root ?? temporary(`plugin-${name}`);
  const version = overrides.version ?? "1.0.0";
  const description = overrides.description ?? `The ${name} plugin`;

  writeJson(root, ".claude-plugin/plugin.json", {
    name,
    version,
    description,
    author: { name: "releasetools" },
    homepage: `https://github.com/releasetools/${name}#readme`,
    repository: `https://github.com/releasetools/${name}`,
    license: "Apache-2.0",
    keywords: [name],
    ...(overrides.claude ?? {}),
  });
  writeJson(root, ".codex-plugin/plugin.json", {
    name,
    version,
    description,
    author: { name: "releasetools" },
    license: "Apache-2.0",
    skills: "./skills/",
    commands: "./commands/",
    interface: {
      displayName: name,
      shortDescription: description,
      longDescription: description,
      category: "Developer Tools",
    },
    ...(overrides.codex ?? {}),
  });
  write(root, "LICENSE", "Apache-2.0\n");
  write(root, "README.md", `# ${name}\n`);
  write(
    root,
    `commands/${name}.md`,
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
  write(
    root,
    `skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
  for (const [relative, contents] of Object.entries(overrides.files ?? {})) {
    write(root, relative, contents);
  }
  return root;
}
