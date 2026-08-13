import { Command, CommanderError, Option } from "commander";
import { login, importToken, authStatus, logout, revoke } from "./auth.js";
import { ConfigStore } from "./config.js";
import { asCliError, CliError } from "./errors.js";
import { collectFile, readBatchInput, readInput } from "./input.js";
import { operationsBatch, operationsDescribe, operationsRun, operationsSearch } from "./operations.js";
import { writeError, writeResult } from "./output.js";
import { listProfiles, showProfile, useProfile } from "./profiles.js";
import type { OutputMode, Runtime } from "./types.js";

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

export function createProgram(runtime: Runtime): Command {
  const program = new Command();
  program.configureOutput({
    writeOut: (text) => runtime.stdout.write(text),
    writeErr: () => undefined,
  });
  program
    .name("scalius")
    .description("Discover and execute Scalius Commerce operations")
    .version("0.1.0")
    .option("--profile <name>", "configuration profile")
    .addOption(new Option("--output <format>", "output format").choices(["human", "json"]).default("human"))
    .showHelpAfterError()
    .showSuggestionAfterError()
    .exitOverride();

  const auth = program.command("auth").description("authenticate the CLI");
  auth.command("login")
    .description("pair with the dashboard")
    .requiredOption("--server <origin>", "Scalius API origin")
    .option("--profile-name <name>", "profile to create")
    .option("--no-open", "do not open the browser")
    .action(async (options: { server: string; profileName?: string; open: boolean }, command) => {
      const profileName = options.profileName ?? globalOptions(command).profile ?? "default";
      const result = await login(runtime, { server: options.server, profileName, openBrowser: options.open });
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

  const operations = program.command("operations").alias("ops").description("discover and execute operations");
  operations.command("search")
    .description("search the live operation contract")
    .argument("[query]")
    .action(async (query: string | undefined, _options, command) => {
      const result = await operationsSearch(runtime, await resolve(runtime, command), query);
      writeResult(runtime, globalOptions(command).output, result, operationSearchSummary(result));
    });
  operations.command("describe")
    .description("describe one executable or continuation operation")
    .argument("<operationId>")
    .action(async (id: string, _options, command) => {
      const result = await operationsDescribe(runtime, await resolve(runtime, command), id);
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
      const result = await operationsRun(runtime, await resolve(runtime, command), id, {
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
      const result = await operationsBatch(runtime, await resolve(runtime, command), input, options.yes);
      writeResult(runtime, globalOptions(command).output, result, `Completed ${String(result.count)} batch step(s).\n${JSON.stringify(result.results, null, 2)}`);
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
