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

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The reader the release-notes plugin carries is the one npm publishes.
 *
 * A plugin installs as a clone of its marketplace and never runs `npm
 * install`, so the file cannot be a dependency at runtime and is carried
 * instead. Carried copies drift, and this one drifting means the plugin and
 * the guards in releasetools/actions disagree about which project a change
 * belongs to, which sends a release note to the wrong changelog. The
 * devDependency pins the version this was copied from; this proves the bytes
 * are still the same.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED = "plugins/release-notes/bin/releasetools-config.cjs";

// The package's main file, which is the reader itself.
const published = createRequire(import.meta.url).resolve(
  "@releasetools/config",
);
const vendored = path.join(ROOT, VENDORED);

const wanted = fs.readFileSync(published, "utf8");
const have = fs.readFileSync(vendored, "utf8");

if (wanted === have) {
  const { version } = JSON.parse(
    fs.readFileSync(path.join(path.dirname(published), "package.json"), "utf8"),
  );
  console.log(`${VENDORED} is @releasetools/config@${version}`);
  process.exit(0);
}

console.error(`${VENDORED} is not what @releasetools/config publishes.`);
console.error("");
console.error("Copy it again, rather than editing it here:");
console.error(
  `  cp node_modules/@releasetools/config/releasetools-config.js ${VENDORED}`,
);
console.error("");
console.error(
  "If the change belongs in the reader, it belongs in releasetools/actions:",
);
console.error(
  "  https://github.com/releasetools/actions/tree/main/packages/config",
);
process.exit(1);
