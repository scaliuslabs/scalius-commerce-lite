import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

export const ADMIN_IMMUTABLE_ASSET_DIR = "assets/immutable";
export const ADMIN_IMMUTABLE_CACHE_CONTROL =
  "public, max-age=31536000, immutable";
export const ADMIN_IMMUTABLE_HEADER_PATTERNS = [
  "/assets/immutable/*.js",
  "/assets/immutable/*.css",
];
export const ADMIN_HASHED_SCRIPT_OR_STYLE_PATTERN =
  /^assets\/immutable\/(?:.+\/)?[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/;

function toPosixPath(value) {
  return value.split("\\").join("/");
}

function collectRelativeFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(toPosixPath(relative(root, absolutePath)));
      }
    }
  }

  visit(root);
  return files.sort();
}

function parseHeaders(content, label) {
  const rules = [];
  const errors = [];
  let currentRule;

  for (const [index, line] of content.split(/\r\n|\r|\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!/^\s/.test(line)) {
      currentRule = { pattern: trimmed, headers: [] };
      rules.push(currentRule);
      continue;
    }

    if (!currentRule) {
      errors.push(`${label}:${index + 1}: header has no URL pattern.`);
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      errors.push(`${label}:${index + 1}: malformed header line.`);
      continue;
    }

    currentRule.headers.push({
      name: trimmed.slice(0, separator).trim().toLowerCase(),
      value: trimmed.slice(separator + 1).trim(),
    });
  }

  return { rules, errors };
}

function validateHeaders(content, label) {
  const parsed = parseHeaders(content, label);
  const errors = [...parsed.errors];
  const allowedPatterns = new Set(ADMIN_IMMUTABLE_HEADER_PATTERNS);

  for (const rule of parsed.rules) {
    const cacheHeaders = rule.headers.filter(
      ({ name }) => name === "cache-control",
    );
    const expiresHeaders = rule.headers.filter(({ name }) => name === "expires");
    const isImmutable = cacheHeaders.some(({ value }) =>
      /(?:^|,)\s*immutable\s*(?:,|$)/i.test(value),
    );
    const hasLongBrowserLifetime = cacheHeaders.some(({ value }) => {
      const match = value.match(/(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/i);
      return match ? Number(match[1]) >= 86_400 : false;
    });

    if (
      (isImmutable || hasLongBrowserLifetime || expiresHeaders.length > 0) &&
      !allowedPatterns.has(rule.pattern)
    ) {
      errors.push(
        `${label}: long-lived browser caching is only allowed for ${ADMIN_IMMUTABLE_HEADER_PATTERNS.join(
          " and ",
        )}; found ${rule.pattern}.`,
      );
    }
  }

  for (const pattern of ADMIN_IMMUTABLE_HEADER_PATTERNS) {
    const matchingRules = parsed.rules.filter((rule) => rule.pattern === pattern);
    if (matchingRules.length !== 1) {
      errors.push(
        `${label}: expected exactly one ${pattern} rule; found ${matchingRules.length}.`,
      );
      continue;
    }

    const cacheHeaders = matchingRules[0].headers.filter(
      ({ name }) => name === "cache-control",
    );
    if (
      cacheHeaders.length !== 1 ||
      cacheHeaders[0].value !== ADMIN_IMMUTABLE_CACHE_CONTROL
    ) {
      errors.push(
        `${label}: ${pattern} must set exactly "Cache-Control: ${ADMIN_IMMUTABLE_CACHE_CONTROL}".`,
      );
    }
  }

  return errors;
}

export function inspectAdminStaticAssets({ rootDir }) {
  const resolvedRoot = resolve(rootDir);
  const publicRoot = resolve(resolvedRoot, "apps/admin-v2/public");
  const distRoot = resolve(resolvedRoot, "apps/admin-v2/dist/client");
  const sourceHeadersPath = resolve(publicRoot, "_headers");
  const distHeadersPath = resolve(distRoot, "_headers");
  const errors = [];

  let sourceHeaders;
  if (!existsSync(sourceHeadersPath)) {
    errors.push("apps/admin-v2/public/_headers is missing.");
  } else {
    sourceHeaders = readFileSync(sourceHeadersPath, "utf8");
    errors.push(
      ...validateHeaders(sourceHeaders, "apps/admin-v2/public/_headers"),
    );
  }

  const publicFiles = collectRelativeFiles(publicRoot);
  for (const file of publicFiles) {
    if (file.startsWith(`${ADMIN_IMMUTABLE_ASSET_DIR}/`)) {
      errors.push(
        `apps/admin-v2/public/${file}: the immutable namespace is reserved for generated client assets.`,
      );
    }
  }

  if (!existsSync(distRoot)) {
    return {
      ok: errors.length === 0,
      errors,
      distPresent: false,
      scripts: 0,
      styles: 0,
      copiedPublicScriptsAndStyles: 0,
    };
  }

  let distHeaders;
  if (!existsSync(distHeadersPath)) {
    errors.push("apps/admin-v2/dist/client/_headers is missing.");
  } else {
    distHeaders = readFileSync(distHeadersPath, "utf8");
    errors.push(
      ...validateHeaders(distHeaders, "apps/admin-v2/dist/client/_headers"),
    );
  }

  if (
    sourceHeaders !== undefined &&
    distHeaders !== undefined &&
    sourceHeaders !== distHeaders
  ) {
    errors.push(
      "apps/admin-v2/dist/client/_headers does not exactly match apps/admin-v2/public/_headers.",
    );
  }

  const distFiles = collectRelativeFiles(distRoot);
  const distFileSet = new Set(distFiles);
  const publicFileSet = new Set(publicFiles);
  let scripts = 0;
  let styles = 0;
  let copiedPublicScriptsAndStyles = 0;

  for (const file of publicFiles) {
    if (![".js", ".css"].includes(extname(file))) continue;
    copiedPublicScriptsAndStyles += 1;
    if (!distFileSet.has(file)) {
      errors.push(
        `apps/admin-v2/dist/client/${file}: copied public script/style is missing or was moved.`,
      );
    }
  }

  for (const file of distFiles) {
    const extension = extname(file);
    const isImmutableNamespace = file.startsWith(
      `${ADMIN_IMMUTABLE_ASSET_DIR}/`,
    );

    if (isImmutableNamespace && (file.endsWith(".map") || extension === ".html")) {
      errors.push(
        `apps/admin-v2/dist/client/${file}: source maps and HTML must stay outside the immutable namespace.`,
      );
      continue;
    }

    if (extension !== ".js" && extension !== ".css") continue;

    if (isImmutableNamespace) {
      if (!ADMIN_HASHED_SCRIPT_OR_STYLE_PATTERN.test(file)) {
        errors.push(
          `apps/admin-v2/dist/client/${file}: immutable scripts/styles require a Vite content hash of at least eight characters.`,
        );
      }
      if (extension === ".js") scripts += 1;
      if (extension === ".css") styles += 1;
      continue;
    }

    if (!publicFileSet.has(file)) {
      errors.push(
        `apps/admin-v2/dist/client/${file}: generated scripts/styles must be emitted under ${ADMIN_IMMUTABLE_ASSET_DIR}/.`,
      );
    }
  }

  if (scripts === 0) {
    errors.push(
      `apps/admin-v2/dist/client/${ADMIN_IMMUTABLE_ASSET_DIR}: no hashed JavaScript assets found.`,
    );
  }
  if (styles === 0) {
    errors.push(
      `apps/admin-v2/dist/client/${ADMIN_IMMUTABLE_ASSET_DIR}: no hashed CSS assets found.`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    distPresent: true,
    scripts,
    styles,
    copiedPublicScriptsAndStyles,
  };
}
