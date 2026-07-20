#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const blockedExactPaths = new Set([
  "AGENTS.md",
  "CLAUDE.md",
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
const blockedMarkdownText = [
  /\bChatGPT\b/iu,
  /\bOpenAI Codex\b/iu,
  /\bClaude Code\b/iu,
  /\bGitHub Copilot\b/iu,
  /\bGemini CLI\b/iu,
  /\bAI[- ]generated\b/iu,
  /\bsubagents?\b/iu,
];

const failures = [];
for (const file of trackedFiles) {
  const normalized = file.split(path.sep).join("/");
  if (
    blockedExactPaths.has(normalized)
    || blockedPrefixes.some((prefix) => normalized.startsWith(prefix))
  ) {
    failures.push(`${normalized}: local assistant/security artifact must not be tracked`);
    continue;
  }

  if (!normalized.toLowerCase().endsWith(".md")) continue;
  const source = readFileSync(file, "utf8");
  for (const pattern of blockedMarkdownText) {
    if (pattern.test(source)) {
      failures.push(`${normalized}: contains public-facing assistant workflow text (${pattern.source})`);
      break;
    }
  }
}

if (failures.length > 0) {
  console.error("Repository hygiene check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Repository hygiene check passed (${trackedFiles.length} tracked files).`);
