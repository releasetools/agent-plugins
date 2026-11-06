/*
 * Reading `.releasetools.yaml`.
 *
 * One implementation, used by the guards in releasetools/actions and by the
 * release-notes plugin, which vendors this file byte for byte. Two readers
 * would be two answers to which project a change belongs to, and the one that
 * disagrees writes a note into the wrong changelog.
 *
 * Plain CommonJS with no dependencies, because a plugin is installed as a
 * clone of its marketplace and never runs `npm install`, and the guards bundle
 * for a Node action. The format it reads is the subset written down in
 * https://github.com/releasetools/conventions/blob/main/FORMAT.md
 */

/** Where a repository says what it holds and which conventions it follows. */
const CONFIG_FILE = '.releasetools.yaml';

/** The spelling somebody reaches for, which would otherwise be read as silence. */
const MISSPELLED = '.releasetools.yml';

/** Edits that are a release writing itself down rather than a change. */
const IGNORED = ['CHANGELOG.md', 'README.md', 'LICENSE'];

/**
 * What a tool says when the repository has declared nothing.
 *
 * Nothing is inferred from a tree: a run with no declaration checks nothing,
 * says so, and stops, rather than guessing at a project and reporting on
 * whatever it guessed.
 */
const ABSENT =
  `no ${CONFIG_FILE} in this repository, so there is nothing to check. Declare the ` +
  'projects it holds, each with the file that carries its version: ' +
  'https://github.com/releasetools/conventions/blob/main/FORMAT.md';

/** What the file said was wrong, in words meant for whoever wrote it. */
class ConfigError extends Error {}

/**
 * A YAML reader for the subset this file is written in.
 *
 * Mappings, lists, scalars and flow lists of scalars, which is everything the
 * format uses. Anything else is refused by name rather than guessed at: a
 * declaration read wrongly sends a guard to the wrong directory and a note to
 * the wrong changelog.
 */
function parseYaml(text, where = CONFIG_FILE) {
  const lines = [];
  text.split('\n').forEach((raw, index) => {
    const number = index + 1;
    if (/^\s*\t/.test(raw)) {
      throw new ConfigError(`${where} line ${number}: YAML indents with spaces`);
    }
    const stripped = stripComment(raw);
    if (stripped.trim() === '' || /^\s*(---|\.\.\.)\s*$/.test(stripped)) {
      return;
    }
    lines.push({
      indent: stripped.length - stripped.trimStart().length,
      text: stripped.trim(),
      number,
    });
  });

  if (lines.length === 0) {
    return {};
  }
  const [value, next] = parseBlock(lines, 0, lines[0].indent, where);
  if (next < lines.length) {
    throw new ConfigError(`${where} line ${lines[next].number}: indented unlike the lines above it`);
  }
  return value;
}

/** Drops a comment, leaving a `#` that is inside quotes alone. */
function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseBlock(lines, start, indent, where) {
  return lines[start].text.startsWith('-')
    ? parseSequence(lines, start, indent, where)
    : parseMapping(lines, start, indent, where);
}

function parseSequence(lines, start, indent, where) {
  const items = [];
  let index = start;
  while (
    index < lines.length &&
    lines[index].indent === indent &&
    lines[index].text.startsWith('-')
  ) {
    const line = lines[index];
    const item = line.text.replace(/^-\s*/, '');
    index += 1;
    if (item === '') {
      if (index < lines.length && lines[index].indent > indent) {
        const [value, next] = parseBlock(lines, index, lines[index].indent, where);
        items.push(value);
        index = next;
        continue;
      }
      items.push(null);
      continue;
    }
    if (isPair(item)) {
      // `- key: value`, whose siblings are indented to where the key starts.
      const inner = indent + (line.text.length - item.length);
      const virtual = [{ indent: inner, text: item, number: line.number }];
      while (index < lines.length && lines[index].indent >= inner && lines[index].indent > indent) {
        virtual.push(lines[index]);
        index += 1;
      }
      const [value, next] = parseMapping(virtual, 0, inner, where);
      if (next < virtual.length) {
        throw new ConfigError(
          `${where} line ${virtual[next].number}: indented unlike the lines above it`,
        );
      }
      items.push(value);
      continue;
    }
    items.push(scalar(item, line.number, where));
  }
  return [items, index];
}

function parseMapping(lines, start, indent, where) {
  const mapping = {};
  let index = start;
  while (index < lines.length && lines[index].indent === indent) {
    const line = lines[index];
    if (line.text.startsWith('-')) {
      break;
    }
    if (!isPair(line.text)) {
      throw new ConfigError(`${where} line ${line.number}: expected 'key: value'`);
    }
    const at = line.text.indexOf(':');
    const key = unquote(line.text.slice(0, at).trim());
    const rest = line.text.slice(at + 1).trim();
    index += 1;

    if (rest !== '') {
      mapping[key] = scalar(rest, line.number, where);
      continue;
    }
    if (index < lines.length && lines[index].indent > indent) {
      const [value, next] = parseBlock(lines, index, lines[index].indent, where);
      mapping[key] = value;
      index = next;
      continue;
    }
    mapping[key] = null;
  }
  return [mapping, index];
}

/** A `key: value` line, rather than a scalar that happens to hold a colon. */
function isPair(text) {
  const at = text.indexOf(':');
  if (at === -1) {
    return false;
  }
  const after = text[at + 1];
  return after === undefined || after === ' ';
}

function scalar(text, number, where) {
  if (/^[&*!]/.test(text) || text === '|' || text === '>') {
    throw new ConfigError(`${where} line ${number}: '${text}' is YAML this does not read`);
  }
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) {
      throw new ConfigError(`${where} line ${number}: a list opened with [ and never closed`);
    }
    const inside = text.slice(1, -1).trim();
    return inside === '' ? [] : inside.split(',').map((item) => scalar(item.trim(), number, where));
  }
  if (text === 'true' || text === 'false') {
    return text === 'true';
  }
  if (text === 'null' || text === '~') {
    return null;
  }
  return unquote(text);
}

function unquote(text) {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
  return quoted ? quoted[2] : text;
}

/**
 * What the file declares, checked.
 *
 * Strict about its own shape: an unknown key is a typo far more often than an
 * intention, and a run configured by a typo checks the wrong thing quietly.
 */
function settingsFrom(text, where = CONFIG_FILE) {
  if (text.trim() === '') {
    return { projects: [], release: {}, ignoreFiles: null, caseSensitive: false, except: [] };
  }

  const parsed = parseYaml(text, where);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${where} must be a mapping of keys, for example:\n  projects:\n    - path: ./`);
  }

  // Unrecognised keys belong to other tools reading the same file.
  return {
    projects: projectsFrom(parsed['projects'], `${where} projects`),
    release: releaseFrom(parsed['release'], `${where} release`),
    ignoreFiles:
      parsed['ignore-files'] === undefined
        ? null
        : strings(parsed['ignore-files'], `${where} ignore-files`),
    caseSensitive: boolean(parsed['case-sensitive'], `${where} case-sensitive`),
    except: exceptions(parsed['conventions'], where),
  };
}

const KEYS = ['path', 'manifest', 'changelog', 'bump'];

/** The release keys that each name one thing. `trigger` takes a list as well, so it is read on its own. */
const RELEASE_KEYS = ['branch', 'merge', 'checks', 'publish', 'registry'];

/**
 * How a release is cut, where the repository says.
 *
 * Unknown keys here are left alone rather than refused: a guard does not act
 * on any of this, and failing a pull request over a key belonging to whatever
 * cuts the release would be answering a question nobody asked it.
 */
function releaseFrom(value, where) {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${where} must be a mapping, for example:\n  release:\n    branch: main`);
  }

  const declared = {};
  for (const key of RELEASE_KEYS) {
    const found = value[key];
    if (found === undefined || found === null) {
      continue;
    }
    if (typeof found !== 'string' || found.trim() === '') {
      throw new ConfigError(`${where} ${key} must be a name, or left out`);
    }
    declared[key] = found.trim();
  }

  const trigger = triggerFrom(value['trigger'], `${where} trigger`);
  if (trigger !== null) {
    if (trigger.includes('dispatch') && declared.publish === undefined) {
      throw new ConfigError(
        `${where} trigger includes dispatch, so ${where} publish must name the workflow it dispatches`,
      );
    }
    declared.trigger = trigger;
  }
  return declared;
}

/** What can start a release's publish workflow. */
const TRIGGERS = ['tag', 'dispatch'];

/**
 * What starts publication, as a list in the order a release tool tries it.
 *
 * One name or a list of them. Null where the file says nothing, which the
 * format reads as `tag`; the reader leaves that to its caller rather than
 * writing a default the file never declared.
 */
function triggerFrom(value, where) {
  if (value === undefined || value === null) {
    return null;
  }
  const names = Array.isArray(value) ? value : [value];
  if (names.length === 0) {
    throw new ConfigError(`${where} must be tag, dispatch, or a list of both, or left out`);
  }
  const seen = [];
  for (const name of names) {
    if (typeof name !== 'string' || !TRIGGERS.includes(name.trim())) {
      throw new ConfigError(`${where} must be tag, dispatch, or a list of both, got ${JSON.stringify(name)}`);
    }
    if (seen.includes(name.trim())) {
      throw new ConfigError(`${where} names ${name.trim()} twice`);
    }
    seen.push(name.trim());
  }
  return seen;
}

/** The groups of projects a repository holds. */
function projectsFrom(value, where) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `${where} must be a list of entries, each with a path, for example:\n` +
        '  projects:\n    - path: packages/api\n      manifest: package.json\n' +
        '      changelog: CHANGELOG.md',
    );
  }
  return value.map((entry, index) => group(entry, `${where} entry ${index + 1}`));
}

function group(entry, where) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new ConfigError(`${where} must be an entry with a path`);
  }

  for (const key of Object.keys(entry)) {
    if (!KEYS.includes(key)) {
      throw new ConfigError(`${where} has no ${key}; the keys are ${KEYS.join(', ')}`);
    }
  }

  const paths = strings(entry['path'], `${where} path`);
  if (paths.length === 0) {
    throw new ConfigError(`${where} needs a path`);
  }
  paths.forEach((value) => inside(value, `${where} path`));

  const manifest = strings(entry['manifest'], `${where} manifest`);
  if (manifest.length === 0) {
    throw new ConfigError(
      `${where} needs a manifest: the file that carries this project's version, or the ` +
        'files that carry it if more than one does. Nothing is guessed.',
    );
  }
  manifest.forEach((value) => inside(value, `${where} manifest`));

  const bump = entry['bump'];
  if (bump !== undefined && bump !== null && typeof bump !== 'string') {
    throw new ConfigError(`${where} bump must be the command that sets the version`);
  }
  const bumps = typeof bump === 'string' ? bump.trim() : '';
  if (bumps !== '' && !bumps.includes('{version}')) {
    throw new ConfigError(
      `${where} bump must say where the version goes, as {version}, for example ` +
        "'uv version {version}'",
    );
  }

  const changelog = entry['changelog'];
  if (changelog !== undefined && changelog !== null && typeof changelog !== 'string') {
    throw new ConfigError(`${where} changelog must be the name of one file`);
  }
  const named = typeof changelog === 'string' ? changelog.trim() : '';
  if (named !== '') {
    inside(named, `${where} changelog`);
  }

  return {
    path: paths,
    manifest,
    ...(named !== '' ? { changelog: named } : {}),
    ...(bumps !== '' ? { bump: bumps } : {}),
  };
}

/**
 * Refuses a path that leaves the repository before anything acts on it.
 *
 * Everything here is read relative to the checkout, and a workflow that wires
 * this from somewhere less trusted should not be one step from reading the
 * runner's home directory.
 */
function inside(value, where) {
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
    throw new ConfigError(`${where} must be inside the repository, so not an absolute path`);
  }
  if (value.split(/[\\/]/).some((segment) => segment === '..')) {
    throw new ConfigError(`${where} must be inside the repository, so no ..`);
  }
  if (/[*?[\]]/.test(value)) {
    throw new ConfigError(
      `${where} names one directory or file, not a pattern. List each project, ` +
        'so what is checked is what the file says rather than what the tree happens to hold.',
    );
  }
}

/** The conventions the repository has opted out of, which no tool then checks. */
function exceptions(value, where) {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${where} conventions must be a mapping with an except list`);
  }
  return strings(value['except'], `${where} conventions except`);
}

/** One name or several, since a group with a single path should not need a list. */
function strings(value, where) {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === 'string') {
    return value.trim() === '' ? [] : [value.trim()];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.map((item) => item.trim()).filter((item) => item !== '');
  }
  throw new ConfigError(`${where} must be one name or a list of them`);
}

function boolean(value, where) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${where} must be true or false`);
  }
  return value;
}


/**
 * Where a release happened, read from its version tag.
 *
 * FORMAT's "Versions and tags" rule 8 makes a release's release commit the
 * commit on the release branch it was cut from, and rule 9 says how a tool
 * finds it: the tagged commit where the branch contains it, and otherwise the
 * commit the tagged commit's Source-Commit trailer names. A repository that
 * publishes a built tree tags a commit on release/vN, which the branch never
 * contains, and `git describe` then answers with whatever older tag the
 * branch still holds. The guards in releasetools/actions and the release-notes
 * plugin both ask this, so it is answered once, here.
 *
 * `git` runs one git command in the repository and returns its exit status
 * and stdout: `(args) => ({ status, stdout })`. Nothing here spawns a process
 * itself, so the reader stays free of anything but the format.
 */

/** A version tag: `v`, a semantic version, no build metadata. */
const VERSION_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** Trailers naming the commit a built tree came from. Workflow-Commit is on tags from before Source-Commit. */
const SOURCE_TRAILERS = ['Source-Commit', 'Workflow-Commit'];

/** The full SHA a commit message's Source-Commit (or older Workflow-Commit) trailer names, or null. */
function sourceCommitIn(message) {
  for (const name of SOURCE_TRAILERS) {
    const found = new RegExp(`^${name}:\\s*<?\\S*?([0-9a-f]{40})>?\\s*$`, 'm').exec(message);
    if (found) {
      return found[1];
    }
  }
  return null;
}

function contains(git, head, commit) {
  return git(['merge-base', '--is-ancestor', commit, head]).status === 0;
}

/**
 * The commit `tag`'s release was cut from, where `head` contains it: the tag
 * itself when `head` holds it, otherwise the full SHA its trailer names. Null
 * when the tag leads back to no commit `head` contains, which is another
 * line's release or a built tree that does not say where it came from.
 */
function releaseCommitOf(git, tag, head = 'HEAD') {
  if (contains(git, head, tag)) {
    return tag;
  }
  const message = git(['log', '-1', '--format=%B', tag]);
  if (message.status !== 0) {
    return null;
  }
  const source = sourceCommitIn(message.stdout);
  return source !== null && contains(git, head, source) ? source : null;
}

/**
 * The previous release as "Judging a version" rule 1 defines it: the newest
 * version tag whose release commit `head` contains.
 *
 * Returns `{ tag, commit, skipped }`: the tag, its release commit (the tag's
 * own name where `head` holds it), and the newer version tags passed over
 * because they lead back to nothing here. Where version tags exist and none
 * leads back, `tag` and `commit` are null. Null when there is no version tag
 * at all. Tags are ordered by git's version sort, with a pre-release before
 * the release it names.
 */
function newestReleaseTag(git, head = 'HEAD') {
  const listed = git(['-c', 'versionsort.suffix=-', 'tag', '--list', 'v*', '--sort=-v:refname']);
  if (listed.status !== 0) {
    return null;
  }
  const tags = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => VERSION_TAG.test(name));
  if (tags.length === 0) {
    return null;
  }
  const skipped = [];
  for (const tag of tags) {
    const commit = releaseCommitOf(git, tag, head);
    if (commit !== null) {
      return { tag, commit, skipped };
    }
    skipped.push(tag);
  }
  return { tag: null, commit: null, skipped };
}

module.exports = {
  ABSENT,
  CONFIG_FILE,
  MISSPELLED,
  IGNORED,
  ConfigError,
  parseYaml,
  settingsFrom,
  projectsFrom,
  sourceCommitIn,
  releaseCommitOf,
  newestReleaseTag,
};
