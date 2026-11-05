#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const blockedExactPaths = new Set([
  "CODEX.md",
  "GEMINI.md",
  "secret-scanning-alerts.json",
]);
const blockedPrefixes = [
  ".claude/",
  ".codex/",
  ".cursor/",
  "audit/",
  "docs/codex/",
  "docs/platform/",
  "docs/research/",
];
// The agent CLI's own docs name the assistants it installs into; that is product text.
// Exact filenames that are exempt from the assistant-text scan (root only).
const agentClientDocExactFiles = ["CLAUDE.md", "AGENTS.md"];
// Prefix-based exemptions (e.g., packages/cli/).
const agentClientDocPrefixes = ["packages/cli/"];
const blockedMarkdownText = [
  /\bChatGPT\b/iu,
  /\bOpenAI Codex\b/iu,
  /\bClaude Code\b/iu,
  /\bGitHub Copilot\b/iu,
  /\bGemini CLI\b/iu,
  /\bAI[- ]generated\b/iu,
  /\bsubagents?\b/iu,
];

export function isSecretBearingEnvPath(file) {
  const basename = path.posix.basename(file.split(path.sep).join("/"));
  const isEnvFile =
    basename === ".env"
    || basename.startsWith(".env.")
    || basename === ".dev.vars"
    || basename.startsWith(".dev.vars.");
  return isEnvFile && !basename.endsWith(".example");
}

// `isPrivate(path)` marks files that never leave a private checkout (a private repository
// strips them on export); they skip the public-tree rules but never the secret check.
export function collectRepositoryHygieneFailures(trackedFiles, {
  readText = (file) => readFileSync(file, "utf8"),
  isPrivate = () => false,
} = {}) {
  const failures = [];
  for (const file of trackedFiles) {
    const normalized = file.split(path.sep).join("/");
    if (isSecretBearingEnvPath(normalized)) {
      failures.push(`${normalized}: secret-bearing environment file must not be tracked`);
      continue;
    }

    if (isPrivate(normalized)) continue;

    if (
      blockedExactPaths.has(normalized)
      || blockedPrefixes.some((prefix) => normalized.startsWith(prefix))
    ) {
      failures.push(`${normalized}: local assistant/security artifact must not be tracked`);
      continue;
    }

    if (!normalized.toLowerCase().endsWith(".md")) continue;
    // Exact filename match for root CLAUDE.md and AGENTS.md; prefix match for packages/cli/.
    const isAgentDoc =
      agentClientDocExactFiles.some((exact) => normalized === exact) ||
      agentClientDocPrefixes.some((prefix) => normalized.startsWith(prefix));
    if (isAgentDoc) continue;
    const source = readText(file);
    for (const pattern of blockedMarkdownText) {
      if (pattern.test(source)) {
        failures.push(`${normalized}: contains public-facing assistant workflow text (${pattern.source})`);
        break;
      }
    }
  }
  return failures;
}

// In the private repository the public tree is `git ls-files` minus the export's strip
// list; the public repository has no strip list, so every tracked file is public there.
async function loadPrivatePathFilter(root) {
  const leakCheck = path.join(root, "internal/export/leak-check.mjs");
  if (!existsSync(path.join(root, "internal/export/strip.paths")) || !existsSync(leakCheck)) return undefined;
  const { isStripped, loadStripRules } = await import(pathToFileURL(leakCheck).href);
  const rules = loadStripRules();
  return (file) => isStripped(rules, file);
}

async function main() {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const isPrivate = await loadPrivatePathFilter(root);
  const failures = collectRepositoryHygieneFailures(trackedFiles, {
    readText: (file) => readFileSync(path.join(root, file), "utf8"),
    isPrivate,
  });

  if (failures.length > 0) {
    console.error("Repository hygiene check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
  }

  const scope = isPrivate
    ? `${trackedFiles.filter((file) => !isPrivate(file)).length} exported of ${trackedFiles.length} tracked files`
    : `${trackedFiles.length} tracked files`;
  console.log(`Repository hygiene check passed (${scope}).`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
