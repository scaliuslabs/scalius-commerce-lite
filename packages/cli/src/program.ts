import { Command, CommanderError, Option } from "commander";
import { readFileSync } from "node:fs";
import { login, importToken, authStatus, logout, revoke } from "./auth.js";
import { ConfigStore } from "./config.js";
import { asCliError, CliError } from "./errors.js";
import { collectFile, readBatchInput, readInput } from "./input.js";
import { uploadMediaFiles } from "./media.js";
import { loadOpenApi } from "./openapi.js";
import { operationsBatch, operationsDescribe, operationsRefresh, operationsRun, operationsSearch } from "./operations.js";
import { writeError, writeResult } from "./output.js";
import { listProfiles, showProfile, useProfile } from "./profiles.js";
import { AGENT_HARNESSES, installSkill, setupHarness, type AgentHarness } from "./skill.js";
import type { OutputMode, Runtime, StructuredInput } from "./types.js";
import { resolveWorkflow } from "./workflows.js";

interface GlobalOptions {
  output: OutputMode;
  profile?: string;
}

interface RunOptions {
  input?: string;
  file: string[];
  idempotencyKey?: string;
  yes: boolean;
  save?: string;
  overwrite: boolean;
}

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new CliError(8, "invalid_package", "The installed Scalius package version is invalid.");
  }
  return manifest.version;
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function humanSummary(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  if (typeof record.status === "string") {
    const profile = typeof record.profile === "string" ? ` (${record.profile})` : "";
    return `${record.status}${profile}`;
  }
  return undefined;
}

function operationSearchSummary(value: Record<string, unknown>): string {
  const operations = Array.isArray(value.operations) ? value.operations as Array<Record<string, unknown>> : [];
  if (operations.length === 0) return "No runnable operations matched.";
  return operations.map((operation) => {
    const summary = typeof operation.summary === "string" ? ` — ${operation.summary}` : "";
    const risk = typeof operation.risk === "string" ? ` [${operation.risk}]` : "";
    const openWorld = operation.openWorld === true ? " [open-world]" : "";
    return `${String(operation.operationId)}${risk}${openWorld}${summary}`;
  }).join("\n");
}

function operationResultSummary(value: Record<string, unknown>): string {
  const heading = `${String(value.operationId)}: HTTP ${String(value.status)}`;
  if (!("data" in value)) return typeof value.savedTo === "string" ? `${heading}\nSaved to ${value.savedTo}` : heading;
  return `${heading}\n${JSON.stringify(value.data, null, 2)}`;
}

async function resolve(runtime: Runtime, command: Command, requireToken = true) {
  const store = new ConfigStore(runtime);
  return store.resolveProfile(globalOptions(command).profile, requireToken);
}

function resourceForOperationId(operationId: string): "dashboard" | "storefront" {
  if (operationId.startsWith("dashboard.")) return "dashboard";
  if (operationId.startsWith("storefront.")) return "storefront";
  throw new CliError(2, "invalid_operation_id", "Operation IDs must start with dashboard. or storefront..");
}

function resourceForBatch(input: StructuredInput): "dashboard" | "storefront" {
  const value = input.body ?? input;
  if (!value || typeof value !== "object" || !Array.isArray((value as { steps?: unknown }).steps)) {
    throw new CliError(5, "invalid_batch", "Batch input must contain a steps array.");
  }
  const resources = new Set((value as { steps: Array<{ operationId?: unknown }> }).steps.map((step) =>
    typeof step?.operationId === "string" ? resourceForOperationId(step.operationId) : "invalid"
  ));
  if (resources.has("invalid") || resources.size !== 1) {
    throw new CliError(5, "mixed_audience_batch", "Every batch step must use the same dashboard or storefront audience.");
  }
  return [...resources][0] as "dashboard" | "storefront";
}

async function resolveForResource(
  runtime: Runtime,
  command: Command,
  resource: "dashboard" | "storefront",
  requireToken = true,
) {
  return new ConfigStore(runtime).resolveProfileForResource(
    resource,
    globalOptions(command).profile,
    requireToken,
  );
}

export function createProgram(runtime: Runtime): Command {
  const program = new Command();
  program.configureOutput({
    writeOut: (text) => runtime.stdout.write(text),
    writeErr: () => undefined,
  });
  program
    .name("scalius")
    .description("Discover and execute Scalius Commerce operations")
    .version(packageVersion())
    .option("--profile <name>", "configuration profile")
    .addOption(new Option("--output <format>", "output format").choices(["human", "json"]).default("human"))
    .showHelpAfterError()
    .showSuggestionAfterError()
    .exitOverride();

  program.command("setup")
    .description("install the portable agent skill and print exact MCP setup")
    .requiredOption("--harness <name>", `agent harness (${AGENT_HARNESSES.join("|")})`)
    .option("--server <origin>", "Scalius API origin; otherwise use the selected profile")
    .option("--force", "replace an existing Scalius skill", false)
    .action(async (options: { harness: string; server?: string; force: boolean }, command) => {
      if (!AGENT_HARNESSES.includes(options.harness as AgentHarness)) {
        throw new CliError(2, "invalid_harness", `Harness must be one of: ${AGENT_HARNESSES.join(", ")}.`);
      }
      const profile = options.server ? undefined : await resolve(runtime, command, false).catch(() => undefined);
      const result = await setupHarness(runtime, {
        harness: options.harness as AgentHarness,
        force: options.force,
        server: options.server ?? profile?.server,
      });
      writeResult(runtime, globalOptions(command).output, result, JSON.stringify(result, null, 2));
    });

  const auth = program.command("auth").description("authenticate the CLI");
  auth.command("login")
    .description("pair with a merchant dashboard or storefront audience")
    .requiredOption("--server <origin>", "Scalius API origin")
    .option("--profile-name <name>", "profile to create")
    .addOption(new Option("--resource <audience>", "credential audience").choices(["dashboard", "storefront"]).default("dashboard"))
    .option("--no-open", "do not open the browser")
    .action(async (options: { server: string; profileName?: string; open: boolean; resource: "dashboard" | "storefront" }, command) => {
      const profileName = options.profileName ?? globalOptions(command).profile ?? "default";
      const result = await login(runtime, { server: options.server, profileName, openBrowser: options.open, resource: options.resource });
      writeResult(runtime, globalOptions(command).output, result, `Authenticated profile '${profileName}'.`);
    });

  const token = auth.command("token").description("manage static credentials");
  token.command("import")
    .description("import a credential from SCALIUS_TOKEN, hidden prompt, or stdin")
    .requiredOption("--server <origin>", "Scalius API origin")
    .option("--profile-name <name>", "profile to create")
    .action(async (options: { server: string; profileName?: string }, command) => {
      const profileName = options.profileName ?? globalOptions(command).profile ?? "default";
      const result = await importToken(runtime, options.server, profileName);
      writeResult(runtime, globalOptions(command).output, result, `Authenticated profile '${profileName}'.`);
    });

  auth.command("status")
    .description("show local authentication status")
    .action(async (_options, command) => {
      const result = await authStatus(runtime, globalOptions(command).profile);
      writeResult(runtime, globalOptions(command).output, result);
    });

  auth.command("logout")
    .description("remove the local credential without revoking it")
    .action(async (_options, command) => {
      const result = await logout(runtime, globalOptions(command).profile);
      writeResult(runtime, globalOptions(command).output, result, humanSummary(result));
    });

  auth.command("revoke")
    .description("revoke the current credential and remove it locally")
    .action(async (_options, command) => {
      const result = await revoke(runtime, globalOptions(command).profile);
      writeResult(runtime, globalOptions(command).output, result, humanSummary(result));
    });

  const profile = program.command("profile").description("manage server profiles");
  profile.command("list")
    .description("list profiles")
    .action(async (_options, command) => {
      const result = await listProfiles(runtime);
      writeResult(runtime, globalOptions(command).output, result);
    });
  profile.command("use")
    .description("select the active profile")
    .argument("<name>")
    .action(async (name: string, _options, command) => {
      const result = await useProfile(runtime, name);
      writeResult(runtime, globalOptions(command).output, result, `Active profile: ${name}`);
    });
  profile.command("show")
    .description("show a profile without revealing its credential")
    .argument("[name]")
    .action(async (name: string | undefined, _options, command) => {
      const result = await showProfile(runtime, name ?? globalOptions(command).profile);
      writeResult(runtime, globalOptions(command).output, result);
    });

  const workflow = program.command("workflow").description("resolve merchant and buyer goals");
  workflow.command("resolve")
    .description("resolve one natural-language goal into the smallest reviewed operation plan")
    .argument("<request>", "merchant or buyer goal")
    .addOption(new Option("--surface <audience>", "workflow audience").choices(["dashboard", "storefront"]).default("dashboard"))
    .action(async (request: string, options: { surface: "dashboard" | "storefront" }, command) => {
      const profile = await resolveForResource(runtime, command, options.surface);
      const document = await loadOpenApi(runtime, profile);
      const result = resolveWorkflow(document, { prompt: request, surface: options.surface });
      writeResult(runtime, globalOptions(command).output, result, JSON.stringify(result, null, 2));
    });

  const operations = program.command("operations").alias("ops").description("discover and execute operations");
  operations.command("refresh")
    .description("refresh the cached live operation contract")
    .addOption(new Option("--surface <audience>", "operation audience").choices(["dashboard", "storefront"]).default("dashboard"))
    .action(async (options: { surface: "dashboard" | "storefront" }, command) => {
      const result = await operationsRefresh(runtime, await resolveForResource(runtime, command, options.surface));
      writeResult(runtime, globalOptions(command).output, result, `Refreshed ${String(result.operationCount)} ${options.surface} operation(s).`);
    });
  operations.command("search")
    .description("search the live operation contract")
    .argument("[query]")
    .option("--limit <count>", "maximum results (1-100)", "20")
    .addOption(new Option("--surface <audience>", "operation audience").choices(["dashboard", "storefront"]))
    .action(async (query: string | undefined, options: { limit: string; surface?: "dashboard" | "storefront" }, command) => {
      const limit = Number(options.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new CliError(2, "invalid_limit", "Search limit must be an integer from 1 to 100.");
      }
      const profile = options.surface
        ? await resolveForResource(runtime, command, options.surface)
        : globalOptions(command).profile
          ? await resolve(runtime, command)
          : await resolveForResource(runtime, command, "dashboard");
      const result = await operationsSearch(runtime, profile, query, limit);
      writeResult(runtime, globalOptions(command).output, result, operationSearchSummary(result));
    });
  operations.command("describe")
    .description("describe one executable or continuation operation")
    .argument("<operationId>")
    .option("--full", "include every response schema", false)
    .action(async (id: string, options: { full: boolean }, command) => {
      const result = await operationsDescribe(runtime, await resolveForResource(runtime, command, resourceForOperationId(id)), id, options.full);
      writeResult(runtime, globalOptions(command).output, result, `${id}\n${JSON.stringify(result, null, 2)}`);
    });
  operations.command("run")
    .description("run one reviewed executable or continuation operation")
    .argument("<operationId>")
    .option("--input <json|@file|->", "structured path/query/body input")
    .option("--file <path|field=@path>", "stream a reviewed raw file or attach a multipart field", collectFile, [])
    .option("--idempotency-key <key>", "idempotency key for a supporting operation")
    .option("--yes", "confirm local risk warning", false)
    .option("--save <path>", "save a contract-declared artifact response")
    .option("--overwrite", "replace an existing --save destination", false)
    .action(async (id: string, options: RunOptions, command) => {
      const input = await readInput(runtime, options.input);
      const result = await operationsRun(runtime, await resolveForResource(runtime, command, resourceForOperationId(id)), id, {
        input,
        files: options.file,
        idempotencyKey: options.idempotencyKey,
        yes: options.yes,
        save: options.save,
        overwrite: options.overwrite,
      });
      writeResult(runtime, globalOptions(command).output, result, operationResultSummary(result as unknown as Record<string, unknown>));
    });
  operations.command("batch")
    .description("execute a bounded sequential operation batch")
    .requiredOption("--input <json|@file|->", "batch input")
    .option("--yes", "confirm local risk warnings", false)
    .action(async (options: { input: string; yes: boolean }, command) => {
      const input = await readBatchInput(runtime, options.input);
      const result = await operationsBatch(runtime, await resolveForResource(runtime, command, resourceForBatch(input)), input, options.yes);
      writeResult(runtime, globalOptions(command).output, result, `Completed ${String(result.count)} batch step(s).\n${JSON.stringify(result.results, null, 2)}`);
    });

  const media = program.command("media").description("run guided media workflows");
  media.command("upload")
    .description("validate and upload one or more local media files")
    .argument("<files...>")
    .option("--folder-id <id>", "destination media folder")
    .option("--yes", "confirm the write", false)
    .action(async (files: string[], options: { folderId?: string; yes: boolean }, command) => {
      if (!options.yes) throw new CliError(2, "confirmation_required", "Media upload writes to the store. Re-run with --yes after reviewing the files.");
      const result = await uploadMediaFiles(runtime, await resolveForResource(runtime, command, "dashboard"), files, options.folderId);
      writeResult(runtime, globalOptions(command).output, result);
    });

  const skill = program.command("skill").description("install the bundled Scalius agent skill");
  skill.command("install")
    .description("install or update the portable Agent Skill")
    .option("--harness <name>", `agent harness (${AGENT_HARNESSES.join("|")})`, "agents")
    .option("--force", "replace an existing Scalius skill", false)
    .action(async (options: { harness: string; force: boolean }, command) => {
      if (!AGENT_HARNESSES.includes(options.harness as AgentHarness)) {
        throw new CliError(2, "invalid_harness", `Harness must be one of: ${AGENT_HARNESSES.join(", ")}.`);
      }
      const result = await installSkill(runtime, options.harness as AgentHarness, options.force);
      writeResult(runtime, globalOptions(command).output, result, `${String(result.status)}: ${String(result.path)}`);
    });

  return program;
}

export async function runProgram(runtime: Runtime, argv: string[]): Promise<number> {
  const program = createProgram(runtime);
  const outputIndex = argv.lastIndexOf("--output");
  let mode: OutputMode = outputIndex >= 0 && argv[outputIndex + 1] === "json" ? "json" : "human";
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      const cliError = new CliError(2, "usage_error", error.message);
      writeError(runtime, mode, cliError);
      return cliError.exitCode;
    }
    const cliError = asCliError(error);
    try {
      mode = program.opts().output === "json" ? "json" : mode;
    } catch {
      // Retain the argument-derived mode.
    }
    writeError(runtime, mode, cliError);
    return cliError.exitCode;
  }
}
