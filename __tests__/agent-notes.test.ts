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
import * as notes from "../plugins/release-notes/bin/agent-notes.mjs";

const {
  PATCH_LINE_LIMIT,
  changelogVersions,
  counts,
  declaredType,
  insertEntry,
  insertSection,
  main,
  parseYaml,
  projectFor,
  projectsIn,
  readConfig,
  readVersion,
  releaseNote,
  scratchPath,
  today,
  versionIn,
  withBlock,
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

function declare(root: string, body: string) {
  fs.writeFileSync(path.join(root, ".releasetools.yaml"), body);
}

function notePath(root: string): string {
  return notes.notePath(root);
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

describe("what a change declares about itself", () => {
  const NOTE = [
    "feat(api): batch mode",
    "",
    "Reviewer prose that is not the note.",
    "",
    "```release-note",
    "Batch mode processes up to 10,000 records per request. Enable it with",
    "the batch=true query parameter.",
    "```",
    "",
    "More prose after it.",
  ].join("\n");

  it("hands over the note the author wrote, and nothing around it", () => {
    const root = repository();
    commit(root, NOTE, { "api.txt": "batch = true\n" });

    const evidence = json(root, ["evidence", "HEAD"]);

    expect(evidence.note.declared).toBe(true);
    expect(evidence.note.none).toBe(false);
    expect(evidence.note.text).toBe(
      "Batch mode processes up to 10,000 records per request. Enable it with\nthe batch=true query parameter.",
    );
    expect(evidence.note.text).not.toContain("Reviewer prose");
  });

  it("reads NONE as an answer rather than a missing block", () => {
    const root = repository();
    commit(root, "refactor: extract the parser\n\n```release-note\nNONE\n```", {
      "parser.txt": "one\n",
    });

    const evidence = json(root, ["evidence", "HEAD"]);

    expect(evidence.note.declared).toBe(true);
    expect(evidence.note.none).toBe(true);
    expect(evidence.note.text).toBeNull();
  });

  it("says when a change declared none, so the diff is all there is", () => {
    const root = repository();
    commit(root, "fix: refuse a bad ref", { "cli.txt": "one\n" });

    const evidence = json(root, ["evidence", "HEAD"]);

    expect(evidence.note).toEqual({
      declared: false,
      none: false,
      text: null,
      blocks: 0,
    });
  });

  it("counts a second block rather than merging it", () => {
    const note = "```release-note\nOne.\n```\n\n```release-note\nTwo.\n```";

    expect(releaseNote(note)).toEqual({
      declared: true,
      none: false,
      text: "One.",
      blocks: 2,
    });
  });

  it("never reads a note out of prose nobody fenced", () => {
    expect(releaseNote("release-note: batch mode is faster").declared).toBe(
      false,
    );
    expect(releaseNote("```text\nBatch mode.\n```").declared).toBe(false);
  });

  it("reads the section and the breaking marker off the subject", () => {
    const root = repository();
    commit(
      root,
      "feat(cli)!: rename the output\n\nBREAKING CHANGE: use --json instead of --format json",
      { "cli.txt": "json\n" },
    );

    const evidence = json(root, ["evidence", "HEAD"]);

    expect(evidence.declares).toEqual({
      type: "feat",
      scope: "cli",
      known: true,
      section: "Added",
      breaking: true,
      breakingSaysHow: true,
    });
  });

  it("leaves a subject that follows no convention with nothing declared", () => {
    expect(declaredType("Refuse where it used to delete", "")).toEqual({
      type: null,
      scope: null,
      known: false,
      section: null,
      breaking: false,
      breakingSaysHow: false,
    });
  });

  it("keeps an unknown type, and gives it no section", () => {
    const declared = declaredType("wip: something", "");

    expect(declared.type).toBe("wip");
    expect(declared.known).toBe(false);
    expect(declared.section).toBeNull();
  });

  it("takes a breaking marker from either the subject or the footer", () => {
    expect(declaredType("fix!: drop the flag", "").breaking).toBe(true);
    expect(
      declaredType("fix: drop the flag", "BREAKING CHANGE: pass --keep")
        .breaking,
    ).toBe(true);
    expect(
      declaredType("fix: drop the flag", "BREAKING CHANGE:").breakingSaysHow,
    ).toBe(false);
  });
});

describe("the declaration every releasetools tool reads", () => {
  it("reads the shape the format defines", () => {
    expect(
      parseYaml(`# How this repository releases.
projects:
  - path: plugins/*
    manifest: plugin.json
    changelog: CHANGELOG.md
  - path:
      - crates/*
      - tools/build
    manifest: Cargo.toml

ignore-files: [CHANGELOG.md, "README.md"]
case-sensitive: false

conventions:
  except:
    - changelog-per-change
`),
    ).toEqual({
      projects: [
        {
          path: "plugins/*",
          manifest: "plugin.json",
          changelog: "CHANGELOG.md",
        },
        { path: ["crates/*", "tools/build"], manifest: "Cargo.toml" },
      ],
      "ignore-files": ["CHANGELOG.md", "README.md"],
      "case-sensitive": false,
      conventions: { except: ["changelog-per-change"] },
    });
  });

  it("leaves a # inside a value alone", () => {
    expect(parseYaml('changelog: "CHANGELOG.md # not a comment"')).toEqual({
      changelog: "CHANGELOG.md # not a comment",
    });
  });

  it("refuses YAML it does not read, rather than guessing", () => {
    expect(() => parseYaml("projects:\n\t- path: ./")).toThrow(
      /indents with spaces/,
    );
    expect(() => parseYaml("projects: &anchor\n  - path: ./")).toThrow(
      /does not read/,
    );
    expect(() => parseYaml("projects:\n  - path: |\n      ./")).toThrow(
      /does not read/,
    );
  });

  it("declares nothing where there is no file, so nothing is written", () => {
    const root = repository();

    const config = readConfig(root);

    // A note written into a changelog nobody named is worse than one nobody
    // wrote, so the commands say so and stop.
    expect(config.found).toBe(false);
    expect(config.groups).toEqual([]);
    expect(config.ignoreFiles).toEqual([
      "CHANGELOG.md",
      "README.md",
      "LICENSE",
    ]);
  });

  it("names the spelling that would otherwise be read as silence", () => {
    const root = repository();
    fs.writeFileSync(
      path.join(root, ".releasetools.yml"),
      "projects:\n  - path: ./\n",
    );

    expect(() => readConfig(root)).toThrow(/\.releasetools\.yml is not read/);
  });

  it("carries the command that sets a project's version, without running it", () => {
    const root = repository();
    declare(
      root,
      "projects:\n  - path: ./\n    manifest: package.json\n    bump: npm version {version} --no-git-tag-version\n",
    );

    expect(readConfig(root).groups[0].bump).toBe(
      "npm version {version} --no-git-tag-version",
    );
  });

  it("resolves the directories the declaration names", () => {
    const root = repository();
    declare(
      root,
      "projects:\n  - path:\n      - plugins/one\n      - plugins/two\n    manifest: plugin.json\n    changelog: CHANGELOG.md\n",
    );
    for (const name of ["one", "two"]) {
      fs.mkdirSync(path.join(root, "plugins", name), { recursive: true });
      fs.writeFileSync(
        path.join(root, "plugins", name, "plugin.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
    }
    fs.mkdirSync(path.join(root, ".hidden"), { recursive: true });

    const projects = projectsIn(root, readConfig(root));

    expect(projects.map((one: { path: string }) => one.path)).toEqual([
      "plugins/one",
      "plugins/two",
    ]);
    expect(projects[0].manifests).toEqual(["plugin.json"]);
  });

  it("gives a file to the deepest project that holds it", () => {
    const projects = [
      { path: "", label: "repo", manifests: [], changelog: "CHANGELOG.md" },
      {
        path: "plugins/one",
        label: "plugins/one",
        manifests: [],
        changelog: "CHANGELOG.md",
      },
    ];

    expect(projectFor(projects, "plugins/one/skills/x.md").path).toBe(
      "plugins/one",
    );
    expect(projectFor(projects, "scripts/build.mjs").path).toBe("");
  });

  it("does not count what a release writes, or what the ignores name", () => {
    const project = {
      path: "plugins/one",
      label: "plugins/one",
      manifests: ["plugin.json"],
      changelog: "CHANGELOG.md",
    };
    const config = {
      ignoreFiles: ["README.md", "docs/**"],
      caseSensitive: false,
    };

    expect(counts("plugins/one/skills/x.md", project, config)).toBe(true);
    expect(counts("plugins/one/plugin.json", project, config)).toBe(false);
    expect(counts("plugins/one/CHANGELOG.md", project, config)).toBe(false);
    expect(counts("plugins/one/ReadMe.md", project, config)).toBe(false);
    expect(counts("plugins/one/docs/deep/page.md", project, config)).toBe(
      false,
    );
  });

  it("reads a version out of whichever manifest an ecosystem uses", () => {
    expect(versionIn("package.json", '{"version": "1.2.3"}')).toBe("1.2.3");
    expect(
      versionIn("Cargo.toml", '[package]\nname = "x"\nversion = "0.4.0"\n'),
    ).toBe("0.4.0");
    expect(versionIn("Chart.yaml", "name: x\nversion: 2.0.1\n")).toBe("2.0.1");
    expect(versionIn("VERSION", "3.1.4\n")).toBe("3.1.4");
  });
});

describe("where one change's entry goes", () => {
  const existing = [
    "# Changelog",
    "",
    "## 0.4.0 - 2026-09-19",
    "",
    "### Added",
    "",
    "The first thing.",
    "",
    "### Fixed",
    "",
    "A fix.",
    "",
    "## 0.3.0 - 2026-09-11",
    "",
    "Older.",
    "",
  ].join("\n");

  it("opens the section when the version has none", () => {
    const { text, added } = insertEntry(existing, {
      version: "0.5.0",
      date: "2026-09-20",
      section: "Added",
      entry: "A second thing.",
    });

    expect(added).toBe(true);
    expect(text).toMatch(
      /## 0\.5\.0 - 2026-09-20\n\n### Added\n\nA second thing\./,
    );
    expect(text.indexOf("## 0.5.0")).toBeLessThan(text.indexOf("## 0.4.0"));
  });

  it("appends under the category the section already has", () => {
    const { text } = insertEntry(existing, {
      version: "0.4.0",
      date: "2026-09-19",
      section: "Added",
      entry: "A second thing.",
    });

    expect(text).toContain("The first thing.\n\nA second thing.\n\n### Fixed");
  });

  it("puts a new category where Keep a Changelog puts it", () => {
    const { text } = insertEntry(existing, {
      version: "0.4.0",
      date: "2026-09-19",
      section: "Removed",
      entry: "A thing went.",
    });

    const section = text.slice(
      text.indexOf("## 0.4.0"),
      text.indexOf("## 0.3.0"),
    );
    expect(section.indexOf("### Added")).toBeLessThan(
      section.indexOf("### Removed"),
    );
    expect(section.indexOf("### Removed")).toBeLessThan(
      section.indexOf("### Fixed"),
    );
  });

  it("leaves an entry that is already there alone, so a second run changes nothing", () => {
    const { text, added } = insertEntry(existing, {
      version: "0.4.0",
      date: "2026-09-19",
      section: "Added",
      entry: "The first thing.",
    });

    expect(added).toBe(false);
    expect(text).toBe(existing);
  });

  it("writes without a category where the change declared no type", () => {
    const { text } = insertEntry(null, {
      version: "0.1.0",
      date: "2026-09-20",
      section: null,
      entry: "The first release.",
    });

    expect(text).toContain("## 0.1.0 - 2026-09-20\n\nThe first release.");
    expect(text).not.toContain("###");
  });
});

describe("the block in a description", () => {
  it("appends one where there is none", () => {
    expect(
      withBlock("Reviewer prose.", {
        none: false,
        text: "Batch mode is faster.",
      }),
    ).toBe("Reviewer prose.\n\n```release-note\nBatch mode is faster.\n```\n");
  });

  it("replaces the one that is there rather than adding a second", () => {
    const body = "Before.\n\n```release-note\nOld.\n```\n\nAfter.";

    const updated = withBlock(body, { none: false, text: "New." });

    expect(updated).toBe("Before.\n\n```release-note\nNew.\n```\n\nAfter.");
    expect(releaseNote(updated).blocks).toBe(1);
  });

  it("writes NONE as the whole block", () => {
    expect(withBlock("", { none: true, text: null })).toBe(
      "```release-note\nNONE\n```\n",
    );
  });
});

describe("one change, from the branch it is on", () => {
  function project(root: string, version: string, changelog?: string) {
    const at = path.join(root, "plugins", "docket");
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(
      path.join(at, "plugin.json"),
      `${JSON.stringify({ version })}\n`,
    );
    if (changelog !== undefined) {
      fs.writeFileSync(path.join(at, "CHANGELOG.md"), changelog);
    }
  }

  function branch(root: string) {
    git(root, ["switch", "--quiet", "--create", "work"]);
  }

  it("finds the project from the declaration, not from the path", () => {
    const root = repository();
    declare(
      root,
      "projects:\n  - path: plugins/docket\n    manifest: plugin.json\n    changelog: CHANGELOG.md\n",
    );
    project(root, "0.1.0", "# docket\n\n## 0.1.0 - 2026-09-01\n\nFirst.\n");
    commit(root, "feat: the project", {});
    branch(root);
    commit(root, "fix(docket): refuse a bad ref", {
      "plugins/docket/skills/x.md": "# x\n",
    });

    const change = json(root, ["change", "--base", "main"]);

    expect(change.config.found).toBe(true);
    expect(change.config.entryPerChange).toBe(true);
    expect(change.projects).toHaveLength(1);
    expect(change.projects[0].path).toBe("plugins/docket");
    expect(change.projects[0].version).toBe("0.1.0");
    expect(change.requires).toBe("patch");
  });

  it("writes the entry into that project's changelog", () => {
    const root = repository();
    declare(
      root,
      "projects:\n  - path: plugins/docket\n    manifest: plugin.json\n    changelog: CHANGELOG.md\n",
    );
    project(root, "0.2.0", "# docket\n\n## 0.1.0 - 2026-09-01\n\nFirst.\n");
    commit(root, "feat: the project", {});
    branch(root);
    commit(root, "feat(docket): a second line", {
      "plugins/docket/skills/x.md": "# x\n",
    });
    json(root, ["change", "--base", "main"]);
    fs.writeFileSync(
      notePath(root),
      "Docket reads a second line, and says which one it took.\n",
    );

    const result = json(root, ["note", "--base", "main"]);

    expect(result.wrote).toHaveLength(1);
    expect(result.section).toBe("Added");
    const changelog = fs.readFileSync(
      path.join(root, "plugins/docket/CHANGELOG.md"),
      "utf8",
    );
    expect(changelog).toContain("## 0.2.0 - ");
    expect(changelog).toContain("### Added\n\nDocket reads a second line");
    expect(changelog.indexOf("## 0.2.0")).toBeLessThan(
      changelog.indexOf("## 0.1.0"),
    );
  });

  it("refuses to write into a version that is already released, and says what to bump to", () => {
    const root = repository();
    declare(
      root,
      "projects:\n  - path: plugins/docket\n    manifest: plugin.json\n    changelog: CHANGELOG.md\n",
    );
    project(root, "0.1.0", "# docket\n\n## 0.1.0 - 2026-09-01\n\nFirst.\n");
    commit(root, "feat: the project", {});
    git(root, ["tag", "docket/v0.1.0"]);
    branch(root);
    commit(root, "feat(docket): a second line", {
      "plugins/docket/skills/x.md": "# x\n",
    });
    json(root, ["change", "--base", "main"]);
    fs.writeFileSync(notePath(root), "A second line.\n");

    const result = json(root, ["note", "--base", "main"]);

    expect(result.wrote).toEqual([]);
    expect(result.skipped[0].why).toContain("0.1.0 is already released");
    expect(result.skipped[0].why).toContain("0.2.0");
    // The note itself is not lost: it is still where it was drafted.
    expect(fs.readFileSync(notePath(root), "utf8")).toContain("A second line.");
  });

  it("writes nothing down for a change that declares NONE", () => {
    const root = repository();
    declare(
      root,
      "projects:\n  - path: plugins/docket\n    manifest: plugin.json\n    changelog: CHANGELOG.md\n",
    );
    project(root, "0.2.0", "# docket\n\n## 0.1.0 - 2026-09-01\n\nFirst.\n");
    commit(root, "feat: the project", {});
    branch(root);
    commit(root, "refactor(docket): extract the parser", {
      "plugins/docket/skills/x.md": "# x\n",
    });

    const result = json(root, ["note", "--base", "main", "--none"]);

    expect(result.note.none).toBe(true);
    expect(result.wrote).toEqual([]);
    expect(result.skipped[0].why).toContain("NONE");
  });

  it("leaves the changelog to the release where the repository excepts the convention", () => {
    const root = repository();
    declare(
      root,
      "projects:\n  - path: plugins/docket\n    manifest: plugin.json\n    changelog: CHANGELOG.md\nconventions:\n  except:\n    - changelog-per-change\n",
    );
    project(root, "0.2.0", "# docket\n\n## 0.1.0 - 2026-09-01\n\nFirst.\n");
    commit(root, "feat: the project", {});
    branch(root);
    commit(root, "feat(docket): a second line", {
      "plugins/docket/skills/x.md": "# x\n",
    });
    fs.writeFileSync(notePath(root), "A second line.\n");

    const result = json(root, ["note", "--base", "main"]);

    expect(result.wrote).toEqual([]);
    expect(result.skipped[0].why).toContain("collates");
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

    expect(run(root, ["section", "0.1.0"]).code).toBe(0);

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

    expect(run(root, ["section", "v0.2.0"]).code).toBe(0);

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

    run(root, ["section", "0.1.0"]);

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

    const result = run(root, ["section", "0.2.0"]);

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

    const result = run(root, ["section", "0.1.0"]);

    expect(result.code).toBe(2);
    expect(result.err).toContain("is empty");
    expect(fs.existsSync(path.join(root, "CHANGELOG.md"))).toBe(false);
  });
});

describe("the date an entry carries", () => {
  it("dates an entry from the commit it names", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });
    // The committer date is when the release landed on the branch, which is
    // what a changelog heading is claiming. --date would move the author's.
    spawnSync("git", ["commit", "--amend", "--quiet", "--no-edit"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_COMMITTER_DATE: "2026-08-19T10:00:00+02:00" },
    });
    git(root, ["tag", "released-in-august"]);
    commit(root, "Later", { "b.txt": "two\n" });
    fs.writeFileSync(scratchPath(root), "What shipped in August.\n");

    const result = run(root, [
      "section",
      "0.1.0",
      "--at",
      "released-in-august",
    ]);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain(
      "## 0.1.0 - 2026-08-19",
    );
  });

  it("dates from today when no commit is named", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });
    fs.writeFileSync(scratchPath(root), "What shipped.\n");

    expect(run(root, ["section", "0.1.0"]).code).toBe(0);

    expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain(
      `## 0.1.0 - ${today()}`,
    );
  });

  it("refuses a revision that is not a commit, writing nothing", () => {
    const root = repository();
    commit(root, "First", { "a.txt": "one\n" });
    fs.writeFileSync(scratchPath(root), "What shipped.\n");

    const result = run(root, ["section", "0.1.0", "--at", "nowhere"]);

    expect(result.code).toBe(2);
    expect(result.err).toContain("--at 'nowhere' is not a commit");
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

describe("one subtree at a time", () => {
  function monorepo(): string {
    const root = repository();
    commit(root, "Both", {
      "plugins/one/README.md": "one\n",
      "plugins/two/README.md": "two\n",
    });
    commit(root, "Only one", { "plugins/one/SKILL.md": "one\n" });
    commit(root, "Only two", { "plugins/two/SKILL.md": "two\n" });
    return root;
  }

  it("counts only the commits that touched it", () => {
    const root = monorepo();

    const scope = json(root, ["commits", "--path", "plugins/one"]);

    expect(scope.path).toBe("plugins/one");
    expect(
      scope.commits.map((entry: { subject: string }) => entry.subject),
    ).toEqual(["Both", "Only one"]);
  });

  it("puts the entry in the subtree's changelog, not the repository's", () => {
    const root = monorepo();
    fs.writeFileSync(
      scratchPath(root, "plugins/one"),
      "The one plugin refuses an empty vault.\n",
    );

    const result = run(root, ["section", "0.1.0", "--path", "plugins/one"]);

    expect(result.code).toBe(0);
    expect(
      fs.readFileSync(path.join(root, "plugins/one/CHANGELOG.md"), "utf8"),
    ).toContain("## 0.1.0 - ");
    expect(fs.existsSync(path.join(root, "CHANGELOG.md"))).toBe(false);
  });

  it("gives the subtree its own scratch file, so two drafts can be in flight", () => {
    const root = monorepo();

    expect(scratchPath(root, "plugins/one")).not.toBe(scratchPath(root));
    expect(scratchPath(root, "plugins/one")).toMatch(
      /RELEASE_EDITMSG-plugins-one$/,
    );
  });

  it("clears only its own scratch file", () => {
    const root = monorepo();
    fs.writeFileSync(scratchPath(root), "the repository's draft\n");
    fs.writeFileSync(scratchPath(root, "plugins/one"), "stale\n");

    json(root, ["commits", "--path", "plugins/one"]);

    expect(fs.readFileSync(scratchPath(root), "utf8")).toBe(
      "the repository's draft\n",
    );
    expect(fs.readFileSync(scratchPath(root, "plugins/one"), "utf8")).toBe("");
  });

  it("reads the repository root as no subtree at all", () => {
    const root = monorepo();

    const scope = json(root, ["commits", "--path", "."]);

    expect(scope.path).toBeNull();
    expect(scope.commits).toHaveLength(3);
  });

  it("refuses a path outside the repository", () => {
    const root = monorepo();

    const result = run(root, ["commits", "--path", os.tmpdir()]);

    expect(result.code).toBe(2);
    expect(result.err).toContain("outside the repository");
  });

  it("refuses a path that is not there", () => {
    const root = monorepo();

    const result = run(root, ["commits", "--path", "plugins/three"]);

    expect(result.code).toBe(2);
    expect(result.err).toContain("is not there");
  });
});
