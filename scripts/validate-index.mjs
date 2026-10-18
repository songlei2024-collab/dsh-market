#!/usr/bin/env node
/**
 * Dependency-free validator for the DSH plugin market index, format 1.
 * Mirrors @deepseek-ai/dsh-plugin-market-index parseMarketIndex (same rules, paths, messages).
 *
 *   node scripts/validate-index.mjs [index.json] [--url <absolute-index-url>] [--targets]
 *
 * Exit code 0 when the index is valid, 1 on the first violated rule.
 * This is a local approximation: DSH re-validates the document when it fetches it.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const PACKAGE_NAME_MAX_LENGTH = 214;
const NUMERIC = "(?:0|[1-9]\\d*)";
const PRERELEASE_PART = "(?:" + NUMERIC + "|\\d*[a-zA-Z-][0-9a-zA-Z-]*)";
const SEMVER = new RegExp(
  "^" + NUMERIC + "\\." + NUMERIC + "\\." + NUMERIC +
  "(?:-" + PRERELEASE_PART + "(?:\\." + PRERELEASE_PART + ")*)?" +
  "(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$", "u");
const COMMIT = /^[0-9a-f]{40}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_INLINE_ICON_BYTES = 32 * 1024;
const MAX_PUBLISH_TIMESTAMP = 1e11;

class MarketIndexError extends Error {
  constructor(path, reason) {
    super(path + " " + reason);
    this.name = "MarketIndexError";
    this.path = path;
    this.reason = reason;
  }
}

function fail(path, reason) {
  throw new MarketIndexError(path, reason);
}

function objectAt(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  return value;
}

function stringAt(value, path) {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a string with a non-whitespace character");
  return value;
}

function optional(object, key, path, read) {
  return Object.hasOwn(object, key) ? read(object[key], path + "." + key) : undefined;
}

function own(record, key, value) {
  Object.defineProperty(record, key, { value: value, enumerable: true, writable: true, configurable: true });
}

function localizedText(value, path) {
  if (typeof value === "string") return stringAt(value, path);
  const object = objectAt(value, path);
  const text = {};
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(path + "." + language, "must be keyed by a lowercase language id");
    own(text, language, stringAt(member, path + "." + language));
  }
  if (!Object.hasOwn(text, "en")) fail(path, "must contain en");
  return text;
}

function declarations(value, path, read) {
  const result = {};
  for (const [id, member] of Object.entries(objectAt(value, path))) {
    if (id === "") fail(path, "must not declare an empty id");
    own(result, id, read(objectAt(member, path + "." + id), path + "." + id));
  }
  return result;
}

function declaration(object, path) {
  return { title: localizedText(object.title, path + ".title") };
}

function sortKeyDeclaration(object, path) {
  if (object.order !== "asc" && object.order !== "desc") fail(path + ".order", 'must be "asc" or "desc"');
  return { title: localizedText(object.title, path + ".title"), order: object.order };
}

function indexMetadata(value, path) {
  const object = value === undefined ? {} : objectAt(value, path);
  return {
    categories: optional(object, "categories", path, (m, at) => declarations(m, at, declaration)) ?? {},
    labels: optional(object, "labels", path, (m, at) => declarations(m, at, declaration)) ?? {},
    sortKeys: optional(object, "sortKeys", path, (m, at) => declarations(m, at, sortKeyDeclaration)) ?? {}
  };
}

function declaredId(value, path, declared) {
  const id = stringAt(value, path);
  if (!Object.hasOwn(declared, id)) fail(path, "references undeclared id " + JSON.stringify(id));
  return id;
}

function pluginMetadata(value, path, index) {
  const object = value === undefined ? {} : objectAt(value, path);
  const category = optional(object, "category", path, (m, at) => declaredId(m, at, index.categories));
  const keywords = optional(object, "keywords", path, (member, at) => {
    if (!Array.isArray(member)) fail(at, "must be an array");
    return member.map((keyword, position) => {
      if (typeof keyword !== "string") fail(at + "[" + position + "]", "must be a string");
      return keyword;
    });
  }) ?? [];
  const labels = optional(object, "labels", path, (member, at) => {
    if (!Array.isArray(member)) fail(at, "must be an array");
    const ids = member.map((label, position) => declaredId(label, at + "[" + position + "]", index.labels));
    if (new Set(ids).size !== ids.length) fail(at, "must not repeat a label");
    return ids;
  }) ?? [];
  const sortKeys = optional(object, "sortKeys", path, (member, at) => {
    const values = {};
    for (const [id, sortValue] of Object.entries(objectAt(member, at))) {
      declaredId(id, at + "." + id, index.sortKeys);
      if (typeof sortValue !== "number" || !Number.isFinite(sortValue)) fail(at + "." + id, "must be a finite number");
      own(values, id, sortValue);
    }
    return values;
  }) ?? {};
  return { ...(category === undefined ? {} : { category: category }), keywords: keywords, labels: labels, sortKeys: sortKeys };
}

function httpUrl(value, path, protocols) {
  const text = stringAt(value, path);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(path, "must be an absolute URL");
  }
  if (!protocols.includes(url.protocol)) fail(path, "must use " + protocols.join(" or "));
  if (url.username !== "" || url.password !== "") fail(path, "must not contain credentials");
  if (url.href.includes("?") || url.href.includes("#")) fail(path, "must not contain a query or fragment");
  return url;
}

function homepageUrl(value, path) {
  const text = stringAt(value, path);
  if (!URL.canParse(text)) fail(path, "must be an absolute URL");
  const url = new URL(text);
  if (url.protocol !== "https:" && url.protocol !== "http:") fail(path, "must use https: or http:");
  return url.href;
}

function gitUrl(value, path) {
  const url = httpUrl(value, path, ["https:"]);
  if (url.href !== value) fail(path, "must be a canonical URL");
  if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) fail(path, "must name a repository with at least two path segments");
  if (/\.(?:tgz|tar\.gz)$/iu.test(url.pathname)) fail(path, "must name a repository, not a tarball");
  return url.href;
}

function packagePath(value, path) {
  const text = stringAt(value, path);
  if (text.split("/").some((segment) => segment === "." || segment === ".." || !PATH_SEGMENT.test(segment))) {
    fail(path, "must be a relative directory of letters, digits, and ._@+- segments without . or ..");
  }
  return text;
}

function repository(value, path) {
  const object = objectAt(value, path);
  const url = httpUrl(object.url, path + ".url", ["https:", "http:"]).href;
  const directory = optional(object, "directory", path, packagePath);
  return { url: url, ...(directory === undefined ? {} : { directory: directory }) };
}

function source(value, path) {
  const object = objectAt(value, path);
  if (object.type === "npm") {
    const registry = optional(object, "registry", path, (m, at) => httpUrl(m, at, ["https:", "http:"]).href);
    return { type: "npm", ...(registry === undefined ? {} : { registry: registry }) };
  }
  if (object.type === "git") {
    const commit = stringAt(object.commit, path + ".commit");
    if (!COMMIT.test(commit)) fail(path + ".commit", "must be a lowercase 40-hex-digit commit SHA");
    const packageDir = optional(object, "path", path, packagePath);
    return {
      type: "git",
      url: gitUrl(object.url, path + ".url"),
      commit: commit,
      ...(packageDir === undefined ? {} : { path: packageDir })
    };
  }
  return fail(path + ".type", 'must be "npm" or "git"');
}

function engines(value, path) {
  const dsh = optional(objectAt(value, path), "dsh", path, (member, at) => {
    const range = stringAt(member, at);
    if (range.startsWith("workspace:")) fail(at, "must not be a workspace: range");
    if (!isSemverRange(range)) fail(at, "must be a SemVer range");
    return range;
  });
  return dsh === undefined ? {} : { dsh: dsh };
}

function icon(value, path, indexUrl) {
  const text = stringAt(value, path);
  if (text.startsWith("data:")) {
    const payload = DATA_ICON.exec(text)?.[1];
    if (payload === undefined || payload === "" || !BASE64.test(payload)) {
      fail(path, "must be a base64 SVG, PNG, JPEG, or WebP data URL");
    }
    const bytes = (payload.length / 4) * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
    if (bytes > MAX_INLINE_ICON_BYTES) fail(path, "must not exceed " + MAX_INLINE_ICON_BYTES / 1024 + " KiB of decoded bytes");
    return text;
  }
  let resolved;
  try {
    resolved = new URL(text, indexUrl);
  } catch {
    fail(path, "must be a URL reference");
  }
  if (resolved.protocol !== "https:" && (resolved.origin === "null" || resolved.origin !== new URL(indexUrl).origin)) {
    fail(path, "must resolve to https or the index origin");
  }
  return resolved.href;
}

function marketVersion(value, path) {
  const object = objectAt(value, path);
  const version = stringAt(object.version, path + ".version");
  if (!SEMVER.test(version)) fail(path + ".version", "must be an exact SemVer version");
  const publishTimestamp = object.publishTimestamp;
  if (typeof publishTimestamp !== "number" || !Number.isInteger(publishTimestamp) ||
      publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
    fail(path + ".publishTimestamp", "must be an integer number of Unix seconds in [0, 10^11)");
  }
  return {
    version: version,
    publishTimestamp: publishTimestamp,
    source: source(object.source, path + ".source"),
    engines: optional(object, "engines", path, engines) ?? {}
  };
}

function versions(value, path) {
  if (!Array.isArray(value) || value.length === 0) fail(path, "must be a non-empty array");
  const seen = new Set();
  const entries = value.map((member, position) => {
    const at = path + "[" + position + "]";
    const entry = marketVersion(member, at);
    if (seen.has(entry.version)) fail(at + ".version", "duplicates " + entry.version);
    seen.add(entry.version);
    return entry;
  });
  return entries.sort((left, right) => compareSemver(right.version, left.version));
}

function plugin(value, path, index, indexUrl) {
  const object = objectAt(value, path);
  const name = stringAt(object.name, path + ".name");
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) fail(path + ".name", "must be a valid npm package name");
  const title = optional(object, "title", path, localizedText);
  const description = optional(object, "description", path, localizedText);
  const iconUrl = optional(object, "icon", path, (member, at) => icon(member, at, indexUrl));
  const author = optional(object, "author", path, stringAt);
  const homepage = optional(object, "homepage", path, homepageUrl);
  const repo = optional(object, "repository", path, repository);
  return {
    name: name,
    ...(title === undefined ? {} : { title: title }),
    ...(description === undefined ? {} : { description: description }),
    ...(iconUrl === undefined ? {} : { icon: iconUrl }),
    ...(author === undefined ? {} : { author: author }),
    ...(homepage === undefined ? {} : { homepage: homepage }),
    ...(repo === undefined ? {} : { repository: repo }),
    metadata: pluginMetadata(object.metadata, path + ".metadata", index),
    versions: versions(object.versions, path + ".versions")
  };
}

export function parseMarketIndex(value, indexUrl) {
  if (!URL.canParse(indexUrl)) fail("$", "index URL " + JSON.stringify(indexUrl) + " must be an absolute URL");
  const base = new URL(indexUrl);
  const object = objectAt(value, "$");
  if (object.format !== 1) fail("$.format", "must be 1");
  const metadata = indexMetadata(object.metadata, "$.metadata");
  if (!Array.isArray(object.plugins)) fail("$.plugins", "must be an array");
  const names = new Set();
  const plugins = object.plugins.map((entry, position) => {
    const parsed = plugin(entry, "$.plugins[" + position + "]", metadata, base);
    if (names.has(parsed.name)) fail("$.plugins[" + position + "].name", "duplicates " + parsed.name);
    names.add(parsed.name);
    return parsed;
  });
  const title = localizedText(object.title, "$.title");
  const description = optional(object, "description", "$", localizedText);
  return {
    format: 1,
    title: title,
    ...(description === undefined ? {} : { description: description }),
    metadata: metadata,
    plugins: plugins
  };
}

export function marketInstallTarget(name, version) {
  const from = version.source;
  if (from.type === "npm") {
    return { spec: name + "@" + version.version, ...(from.registry === undefined ? {} : { registry: from.registry }) };
  }
  const url = from.url.endsWith(".git") ? from.url : from.url + ".git";
  const pathParam = from.path === undefined ? "" : "&path:/" + from.path;
  return { spec: "git+" + url + "#" + from.commit + pathParam };
}

/* ---------- SemVer helpers (local approximation; DSH uses node-semver) ---------- */

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split(".")
  };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    } else if (xNumeric) {
      return -1;
    } else if (yNumeric) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function isPartialVersion(text) {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x" || trimmed === "X") return true;
  return /^v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(trimmed);
}

function isComparator(token) {
  const trimmed = token.trim();
  if (trimmed === "") return false;
  const bare = /^(?:<=|>=|<|>|=|~>|~|\^)?(.*)$/u.exec(trimmed)[1];
  return isPartialVersion(bare);
}

function isSemverRange(range) {
  const alternatives = range.split("||");
  if (alternatives.length === 0) return false;
  return alternatives.every((alternative) => {
    const text = alternative.trim();
    if (text === "") return false;
    const hyphen = text.split(" - ");
    if (hyphen.length > 1) {
      return hyphen.length === 2 && isPartialVersion(hyphen[0]) && isPartialVersion(hyphen[1]);
    }
    return text.split(/\s+/u).every(isComparator);
  });
}

/* ---------- CLI ---------- */

function textOf(value) {
  if (typeof value === "string") return value;
  return value.zh ?? value.en ?? Object.values(value)[0];
}

function main() {
  const argv = process.argv.slice(2);
  const positional = [];
  let url = "http://127.0.0.1:8788/index.json";
  let targets = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--targets") targets = true;
    else if (arg === "--url") {
      index += 1;
      url = argv[index];
      if (url === undefined) {
        console.error("--url needs a value");
        process.exit(1);
      }
    } else if (arg.startsWith("--url=")) url = arg.slice("--url=".length);
    else if (arg === "-h" || arg === "--help") {
      console.log("usage: node scripts/validate-index.mjs [index.json] [--url <absolute-index-url>] [--targets]");
      return;
    } else if (arg.startsWith("-")) {
      console.error("unknown option " + arg);
      process.exit(1);
    } else positional.push(arg);
  }

  const file = resolve(positional[0] ?? "index.json");
  return readFile(file, "utf8").then((raw) => {
    let document;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      console.error("INVALID " + file + "\n  not valid JSON: " + error.message);
      process.exit(1);
    }

    let parsed;
    try {
      parsed = parseMarketIndex(document, url);
    } catch (error) {
      if (error instanceof MarketIndexError) {
        console.error("INVALID " + file + "\n  at " + error.path + "\n  " + error.reason);
        process.exit(1);
      }
      throw error;
    }

    const versionsTotal = parsed.plugins.reduce((sum, entry) => sum + entry.versions.length, 0);
    console.log("OK " + file);
    console.log("  title      " + textOf(parsed.title));
    console.log("  index url  " + url);
    console.log("  declares   " + Object.keys(parsed.metadata.categories).length + " categories, " +
      Object.keys(parsed.metadata.labels).length + " labels, " +
      Object.keys(parsed.metadata.sortKeys).length + " sort keys");
    console.log("  plugins    " + parsed.plugins.length + " (" + versionsTotal + " versions)");

    for (const entry of parsed.plugins) {
      const fallback = entry.versions[0];
      const extra = entry.versions.length > 1 ? " (+" + (entry.versions.length - 1) + " older)" : "";
      console.log("  - " + entry.name + " " + fallback.version + extra);
      if (fallback.engines.dsh === undefined) {
        console.log("      note: no engines.dsh, so this entry installs on any DSH version");
      }
      if (targets) {
        for (const version of entry.versions) {
          const target = marketInstallTarget(entry.name, version);
          const registry = target.registry === undefined ? "" : "  [registry " + target.registry + "]";
          console.log("      " + version.version + " -> " + target.spec + registry);
        }
      }
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
