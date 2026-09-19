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

/** Files a project may keep its version in, where a group names none. */
const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'VERSION'];

/** Edits that are a release writing itself down rather than a change. */
const IGNORED = ['CHANGELOG.md', 'README.md', 'LICENSE'];

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
    return { projects: [], ignoreFiles: null, caseSensitive: false, except: [] };
  }

  const parsed = parseYaml(text, where);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${where} must be a mapping of keys, for example:\n  projects:\n    - path: ./`);
  }

  // Unrecognised keys belong to other tools reading the same file.
  return {
    projects: projectsFrom(parsed['projects'], `${where} projects`),
    ignoreFiles:
      parsed['ignore-files'] === undefined
        ? null
        : strings(parsed['ignore-files'], `${where} ignore-files`),
    caseSensitive: boolean(parsed['case-sensitive'], `${where} case-sensitive`),
    except: exceptions(parsed['conventions'], where),
  };
}

const KEYS = ['path', 'manifest', 'changelog', 'bump'];

/** The groups of projects a repository holds. */
function projectsFrom(value, where) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `${where} must be a list of entries, each with a path, for example:\n` +
        '  projects:\n    - path: packages/*\n      manifest: package.json\n' +
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
    ...(manifest.length > 0 ? { manifest } : {}),
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

module.exports = {
  CONFIG_FILE,
  MISSPELLED,
  MANIFESTS,
  IGNORED,
  ConfigError,
  parseYaml,
  settingsFrom,
  projectsFrom,
};
