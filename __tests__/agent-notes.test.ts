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
// @ts-expect-error - plugin tooling, deliberately plain JS with no types
import * as notes from "../plugins/release-notes/skills/release-notes/agent-notes.mjs";

const {
  PATCH_LINE_LIMIT,
  changelogVersions,
  insertSection,
  main,
  readVersion,
  scratchPath,
  today,
} = notes;

/**
 * The half of drafting release notes that has to be the same every time.
 *
 * What the model does with the evidence is not checked here. What is checked
 * is that it gets all of it, that a diff nobody can read is replaced by its
 * length rather than sent anyway, and that the two files the entry lands in
 * cannot end up carrying different bodies - which is the failure that reaches
 * a user, since one of them is what gets published.
 */

const repositories: string[] = [];

afterAll(() => {
  for (const root of repositories) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function repository(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "notes-")),
  );
  repositories.push(root);
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "tag.gpgsign", "false"]);
  return root;
}

function commit(root: string, message: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  }
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--message", message]);
}

function run(root: string, argv: string[]) {
  let out = "";
  let err = "";
  const code = main(argv, {
    cwd: root,
    stdout: {
      write: (text: string) => {
        out += text;
      },
    },
    stderr: {
      write: (text: string) => {
        err += text;
      },
    },
  });
  return { code, out, err };
}

function json(root: string, argv: string[]) {
  const result = run(root, argv);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.out);
}

describe("what is in scope", () => {
  it("takes the whole history when nothing has been released", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });
    commit(root, "Second", { "b.txt": "two\n" });

    const scope = json(root, ["commits"]);

    expect(scope.previousTag).toBeNull();
    expect(scope.firstRelease).toBe(true);
    expect(scope.range).toBe("HEAD");
    expect(
      scope.commits.map((entry: { subject: string }) => entry.subject),
    ).toEqual(["First", "Second"]);
  });

  it("stops at the previous tag", () => {
    const root = repository();
    commit(root, "Released", { "a.txt": "one\n" });
    git(root, ["tag", "v0.1.0"]);
    commit(root, "Since", { "b.txt": "two\n" });

    const scope = json(root, ["commits"]);

    expect(scope.previousTag).toBe("v0.1.0");
    expect(scope.range).toBe("v0.1.0..HEAD");
    expect(scope.commits).toHaveLength(1);
    expect(scope.commits[0].files).toBe(1);
    expect(scope.commits[0].insertions).toBe(1);
  });

  it("clears the scratch file before it reads anything", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });
    const scratch = scratchPath(root);
    fs.writeFileSync(scratch, "the previous release's body\n");

    const scope = json(root, ["commits"]);

    expect(scope.scratchFile).toBe(scratch);
    expect(fs.readFileSync(scratch, "utf8")).toBe("");
  });
});

describe("one commit's evidence", () => {
  it("hands over the patch, so the message can be checked against it", () => {
    const root = repository();
    commit(root, "Refuse where it used to delete", {
      "cli.txt": "delete = false\n",
    });

    const evidence = json(root, ["evidence", "HEAD"]);

    expect(evidence.subject).toBe("Refuse where it used to delete");
    expect(evidence.merge).toBe(false);
    expect(evidence.files).toEqual(["cli.txt"]);
    expect(evidence.patch).toContain("+delete = false");
    expect(evidence.patchOmitted).toBeNull();
  });

  it("replaces a patch nobody would read with its length", () => {
    const root = repository();
    const long = Array.from(
      { length: PATCH_LINE_LIMIT + 200 },
      (_unused, index) => `line ${index}`,
    ).join("\n");
    commit(root, "Vendor a generated file", { "generated.txt": `${long}\n` });

    const evidence = json(root, ["evidence", "HEAD"]);

    expect(evidence.patch).toBeNull();
    expect(evidence.patchOmitted.limit).toBe(PATCH_LINE_LIMIT);
    expect(evidence.patchOmitted.lines).toBeGreaterThan(PATCH_LINE_LIMIT);
    expect(evidence.stat).toContain("generated.txt");
    expect(evidence.files).toEqual(["generated.txt"]);
  });

  it("says when a commit is a merge, whose body is usually the pull request", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });
    git(root, ["switch", "--quiet", "--create", "feature"]);
    commit(root, "On the branch", { "b.txt": "two\n" });
    git(root, ["switch", "--quiet", "main"]);
    git(root, [
      "merge",
      "--no-ff",
      "--quiet",
      "--message",
      "Merge #1",
      "feature",
    ]);

    const evidence = json(root, ["evidence", "HEAD"]);

    expect(evidence.subject).toBe("Merge #1");
    expect(evidence.merge).toBe(true);
  });

  it("never hands over the author, who must not reach an entry", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });

    expect(Object.keys(json(root, ["evidence", "HEAD"]))).not.toContain(
      "author",
    );
  });
});

describe("where the entry lands", () => {
  function drafted(root: string, body: string) {
    fs.writeFileSync(scratchPath(root), body);
  }

  it("creates a changelog for a repository that has none", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });
    drafted(root, "### Added\n\nIt runs.\n");

    expect(run(root, ["write", "0.1.0"]).code).toBe(0);

    const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("# Changelog");
    expect(changelog).toContain(`## 0.1.0 - ${today()}`);
    expect(changelog).toContain("It runs.");
  });

  it("puts the new version above the old one and below the preamble", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });
    fs.writeFileSync(
      path.join(root, "CHANGELOG.md"),
      "# Changelog\n\nA preamble.\n\n## 0.1.0 - 2026-01-01\n\nThe first one.\n",
    );
    drafted(root, "### Fixed\n\nIt stopped deleting things.\n");

    expect(run(root, ["write", "v0.2.0"]).code).toBe(0);

    const lines = fs
      .readFileSync(path.join(root, "CHANGELOG.md"), "utf8")
      .split("\n");
    expect(lines[0]).toBe("# Changelog");
    expect(lines.filter((line) => line.startsWith("## "))).toEqual([
      `## 0.2.0 - ${today()}`,
      "## 0.1.0 - 2026-01-01",
    ]);
    expect(lines).toContain("A preamble.");
    expect(lines).toContain("The first one.");
  });

  it("leaves the same body in the scratch file, with no heading", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });
    drafted(root, "\n### Added\n\nIt runs.\n\n\n");

    run(root, ["write", "0.1.0"]);

    const scratch = fs.readFileSync(scratchPath(root), "utf8");
    expect(scratch).toBe("### Added\n\nIt runs.\n");
    expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain(
      scratch,
    );
  });

  it("refuses a version the changelog already carries", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });
    fs.writeFileSync(
      path.join(root, "CHANGELOG.md"),
      "# Changelog\n\n## 0.2.0 - 2026-01-01\n\nAlready written.\n",
    );
    drafted(root, "### Added\n\nSomething else.\n");

    const result = run(root, ["write", "0.2.0"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("already has a section for 0.2.0");
    expect(
      fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
    ).not.toContain("Something else.");
  });

  it("refuses an empty scratch file rather than writing a blank release", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });
    drafted(root, "   \n\n");

    const result = run(root, ["write", "0.1.0"]);

    expect(result.code).toBe(2);
    expect(result.err).toContain("is empty");
    expect(fs.existsSync(path.join(root, "CHANGELOG.md"))).toBe(false);
  });
});

describe("versions and headings", () => {
  it("takes a version with or without its v, and refuses anything else", () => {
    expect(readVersion("v1.2.3")).toBe("1.2.3");
    expect(readVersion("1.2.3")).toBe("1.2.3");
    expect(readVersion("1.2.3-rc.1")).toBe("1.2.3-rc.1");
    expect(() => readVersion("next")).toThrow(/not a version/);
    expect(() => readVersion("1.2")).toThrow(/not a version/);
  });

  it("reads a heading with or without its date", () => {
    expect(
      changelogVersions("## 0.2.0 - 2026-01-01\n\ntext\n\n## 0.1.0\n"),
    ).toEqual(["0.2.0", "0.1.0"]);
  });

  it("appends to a changelog that has no versions yet", () => {
    expect(
      insertSection("# Changelog\n", "0.1.0 - 2026-01-01", "It runs."),
    ).toBe("# Changelog\n\n## 0.1.0 - 2026-01-01\n\nIt runs.\n");
  });
});
