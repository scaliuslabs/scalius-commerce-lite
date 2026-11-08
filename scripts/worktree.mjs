#!/usr/bin/env node
// Agent worktrees: cut from the local lead branch and test-ready in seconds.
//
//   pnpm worktree add <name> [--base mono-repo] [--branch <branch>] [--dir <path>]
//   pnpm worktree remove <name|path> [--keep-branch] [--force]
//   pnpm worktree list
//
// `add` creates `.claude/worktrees/<name>` on branch `wt/<name>` from the
// local `mono-repo` (never origin, which lags behind), installs from the pnpm
// store with no network (`pnpm install --offline --frozen-lockfile`), and
// defines the generated-file merge driver, and generates the worktree's own
// local development secrets (`scripts/dev-setup.mjs --env-only`: fresh
// values, never copied from another checkout), so `pnpm dev --api-port <n>
// ... --state <dir>` starts an isolated stack there. Nothing else is needed to test:
// the Turborepo cache is shared across worktrees by Turborepo itself, the
// migrated SQLite images live in the user cache, and the TypeScript build
// info is per worktree under node_modules/.cache. No dev server starts.
// `remove` deletes the worktree and its branch once that branch is merged
// (`--force` drops unmerged work and a dirty tree too).
import { spawnSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePnpmExecutable } from "./dev-local-utils.mjs";

const here = resolve(import.meta.dirname, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

const git = (args, options = {}) => run("git", args, { cwd: here, ...options });

/** The main checkout: the directory holding the shared .git. */
export function mainCheckout() {
  return dirname(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim());
}

/** Parsed `git worktree list --porcelain`. */
export function worktrees() {
  const out = git(["worktree", "list", "--porcelain"]).stdout;
  return out.split("\n\n").filter(Boolean).map((block) => {
    const fields = Object.fromEntries(block.split("\n").map((line) => {
      const space = line.indexOf(" ");
      return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)];
    }));
    return { path: fields.worktree, head: fields.HEAD, branch: typeof fields.branch === "string" ? fields.branch.replace(/^refs\/heads\//u, "") : null };
  });
}

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) positional.push(arg);
    else if (["--keep-branch", "--force"].includes(arg)) flags[arg.slice(2)] = true;
    else flags[arg.slice(2)] = argv[++index];
  }
  return { command: positional[0], name: positional[1], flags };
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const freeBytes = (path) => {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
};
/**
 * Creates the checkout's local development env files with the project's own
 * setup path. It generates new secrets in that checkout and reads no other
 * checkout's files; its output names files, never values.
 */
export function provisionLocalEnv(path) {
  run(process.execPath, [join(path, "scripts/dev-setup.mjs"), "--env-only"], { cwd: path });
}

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

function add(name, flags) {
  if (!name || !NAME.test(name)) throw new Error("worktree add <name>: lower-case letters, digits, . _ -");
  const main = mainCheckout();
  const base = flags.base ?? "mono-repo";
  const branch = flags.branch ?? `wt/${name}`;
  const path = flags.dir ? resolve(flags.dir) : join(main, ".claude/worktrees", name);
  if (existsSync(path)) throw new Error(`${path} exists`);
  git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  const started = Date.now();
  const before = freeBytes(main);
  git(["worktree", "add", "--quiet", "-b", branch, path, base]);
  const checkout = Date.now();
  const install = spawnSync(resolvePnpmExecutable(), ["install", "--offline", "--frozen-lockfile", "--reporter=silent"], { cwd: path, stdio: "inherit" });
  if (install.status !== 0) throw new Error(`pnpm install --offline failed in ${path} (exit ${install.status}); the store lacks a package: run pnpm install once in ${main}.`);
  run(process.execPath, [join(path, "scripts/regen-after-merge.mjs"), "--install"], { cwd: path });
  provisionLocalEnv(path);
  const done = Date.now();
  const used = Math.max(0, before - freeBytes(main));
  console.log([
    `Worktree ${path}`,
    `  branch ${branch} from ${base} at ${git(["rev-parse", "--short", base]).stdout.trim()}`,
    `  checkout ${((checkout - started) / 1000).toFixed(1)}s, install ${((done - checkout) / 1000).toFixed(1)}s, disk ${gib(used)} (free ${gib(freeBytes(main))})`,
    "  local dev env generated; run a stack with: pnpm dev --api-port <n> --storefront-port <n> --admin-port <n> --state <dir>",
    `  remove with: pnpm worktree remove ${name}`,
  ].join("\n"));
}

function findWorktree(target) {
  const main = mainCheckout();
  const candidates = [isAbsolute(target) ? target : join(main, ".claude/worktrees", target), resolve(target)];
  const found = worktrees().find((entry) => candidates.includes(entry.path));
  if (!found) throw new Error(`no worktree ${target}`);
  if (found.path === main) throw new Error("refusing to remove the main checkout");
  return found;
}

function remove(target, flags) {
  if (!target) throw new Error("worktree remove <name|path>");
  const entry = findWorktree(target);
  if (resolve(here) === entry.path) throw new Error("run remove from another checkout, not the worktree being removed");
  const main = mainCheckout();
  const before = freeBytes(main);
  git(["worktree", "remove", ...(flags.force ? ["--force", "--force"] : []), entry.path]);
  git(["worktree", "prune"]);
  let note = "";
  if (entry.branch && !flags["keep-branch"]) {
    const deleted = git(["branch", flags.force ? "-D" : "-d", entry.branch], { allowFailure: true });
    note = deleted.status === 0 ? `, branch ${entry.branch} deleted` : `, branch ${entry.branch} kept (not merged; --force deletes it)`;
  }
  console.log(`Removed ${entry.path}${note}; freed ${gib(Math.max(0, freeBytes(main) - before))}.`);
}

function list() {
  const main = mainCheckout();
  for (const entry of worktrees()) {
    const label = entry.path === main ? "(main)" : basename(entry.path);
    console.log(`${label.padEnd(36)} ${(entry.branch ?? "(detached)").padEnd(48)} ${entry.head?.slice(0, 9) ?? ""}`);
  }
}

async function main() {
  const { command, name, flags } = parseArgs(process.argv.slice(2));
  if (command === "add") return add(name, flags);
  if (command === "remove") return remove(name, flags);
  if (command === "list") return list();
  console.log("pnpm worktree add <name> [--base mono-repo] [--branch b] [--dir path] | remove <name|path> [--keep-branch] [--force] | list");
  process.exitCode = command ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
