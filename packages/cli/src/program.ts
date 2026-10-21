import { Argument, Command, CommanderError, Option } from "commander";
import { ask, batch, describe, read, search, write, type OutputOptions } from "./agent.js";
import { login, importToken, authStatus, logout, revoke } from "./auth.js";
import { serveMcpBridge } from "./bridge.js";
import { BULK_KINDS, bulk, type BulkKind, type BulkOptions } from "./bulk.js";
import { ConfigStore } from "./config.js";
import { doctorExitCode, renderDoctor, runDoctor } from "./doctor.js";
import { asCliError, CliError } from "./errors.js";
import { EXPORT_KINDS, exportArtifact, type ExportKind } from "./export.js";
import { parseHarnesses } from "./harness.js";
import { commandTree } from "./help-json.js";
import { renderInit, runInit } from "./init.js";
import { collectFile, readBatchInput, readInput } from "./input.js";
import type { Audience } from "./mcp-client.js";
import { uploadMediaFiles } from "./media.js";
import { isObjectOperationId, loadOpenApi } from "./openapi.js";
import { operationsBatch, operationsDescribe, operationsRefresh, operationsRun, operationsSearch } from "./operations.js";
import { resolveOutputMode, writeError, writeResult } from "./output.js";
import { listProfiles, showProfile, useProfile } from "./profiles.js";
import { parseSelect } from "./select.js";
import { AGENT_HARNESSES, installSkill, setupHarness, type AgentHarness } from "./skill.js";
import type { OutputMode, Runtime, StructuredInput } from "./types.js";
import { packageVersion } from "./version.js";
import { readWorkflow } from "./workflow-read.js";
import { resolveWorkflow } from "./workflows.js";

interface GlobalOptions {
  output?: string;
  profile?: string;
  select?: string;
  jq?: string;
}

interface RunOptions {
  input?: string;
  file: string[];
  idempotencyKey?: string;
  yes: boolean;
  approval?: string;
  save?: string;
  overwrite: boolean;
}

/** Set by a command that finishes with a non-zero exit code it already reported (10, 11, doctor). */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
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

function resourceForOperationId(operationId: string): "dashboard" | "storefront" {
  if (operationId.startsWith("dashboard.") || isObjectOperationId(operationId)) return "dashboard";
  if (operationId.startsWith("storefront.")) return "storefront";
  throw new CliError(2, "invalid_operation_id", "Use a dashboard, storefront or supported objects operation ID.");
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

function positiveInteger(name: string, value: string | undefined, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new CliError(2, `invalid_${name.replace(/-/g, "_")}`, `--${name} must be an integer from 1 to ${maximum}.`);
  }
  return number;
}

const surfaceOption = () => new Option("--surface <audience>", "dashboard (merchant) or storefront (buyer) tools").choices(["dashboard", "storefront"]).default("dashboard");

export function createProgram(runtime: Runtime): Command {
  const program = new Command();
  const globals = (command: Command): GlobalOptions => command.optsWithGlobals() as GlobalOptions;
  const mode = (command: Command): OutputMode => resolveOutputMode(runtime, globals(command).output);
  const output = (command: Command): OutputOptions => {
    const options = globals(command);
    return {
      mode: mode(command),
      ...(options.select ? { select: parseSelect(options.select) } : {}),
      ...(options.jq ? { jq: options.jq } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
    };
  };
  const resolve = (command: Command, requireToken = true) =>
    new ConfigStore(runtime).resolveProfile(globals(command).profile, requireToken);
  const resolveForResource = (command: Command, resource: "dashboard" | "storefront", requireToken = true) =>
    new ConfigStore(runtime).resolveProfileForResource(resource, globals(command).profile, requireToken);
  const finish = (code: number) => {
    if (code !== 0) throw new ExitSignal(code);
  };

  program.configureOutput({
    writeOut: (text) => runtime.stdout.write(text),
    writeErr: () => undefined,
  });
  program
    .name("scalius")
    .description("Run a Scalius Commerce store from the terminal or any agent")
    .version(packageVersion())
    .option("--profile <name>", "configuration profile")
    .addOption(new Option("--output <format>", "output format (default: human on a terminal, json when piped)").choices(["human", "json"]))
    .option("--select <pointers>", "keep only these JSON pointers of data, comma-separated (/items/*/id,/total)")
    .option("--jq <expression>", "filter data with a built-in jq expression; strings print raw")
    .showHelpAfterError()
    .showSuggestionAfterError()
    .exitOverride();

  // ─── Connect ──────────────────────────────────────────────────────────────

  program.command("init")
    .description("connect this machine's agents to a store in one step: pair once, install skills, register MCP, verify")
    .option("--server <origin>", "store API origin (https://api.yourstore.com)")
    .option("--harness <names>", "auto, or comma-separated: claude, codex, cursor, opencode, pi, agents", "auto")
    .option("--storefront", "also connect the buyer (storefront) tools; needs a second approval", false)
    .option("--no-auth", "skip pairing (install skills and MCP only)")
    .option("--no-open", "print the approval link instead of opening the browser")
    .option("--profile-name <name>", "name for the new profile")
    .action(async (options: { server?: string; harness: string; storefront: boolean; auth: boolean; open: boolean; profileName?: string }, command) => {
      parseHarnesses(options.harness);
      const { result, exitCode } = await runInit(runtime, options);
      writeResult(runtime, mode(command), result, renderInit(result));
      finish(exitCode);
    });

  program.command("doctor")
    .description("check every link from this machine to the store, with the fix for each problem")
    .option("--harness <names>", "auto, or comma-separated harness names", "auto")
    .addOption(surfaceOption())
    .action(async (options: { harness: string; surface: Audience }, command) => {
      const harnesses = parseHarnesses(options.harness);
      const report = await runDoctor(runtime, {
        profile: globals(command).profile,
        audience: options.surface,
        ...(harnesses === "auto" ? {} : { harnesses }),
      });
      writeResult(runtime, mode(command), report, renderDoctor(report));
      finish(doctorExitCode(report));
    });

  program.command("mcp")
    .description("serve the store's MCP tools over stdio with the paired credential (agent harnesses launch this)")
    .addOption(surfaceOption())
    .action(async (options: { surface: Audience }, command) => {
      await serveMcpBridge(runtime, { audience: options.surface, profile: globals(command).profile });
    });

  // ─── Agent commands ───────────────────────────────────────────────────────

  program.command("ask")
    .description("answer a store-data question in one bounded call (= scalius_answer)")
    .argument("<question...>")
    .addOption(surfaceOption())
    .action(async (words: string[], options: { surface: Audience }, command) => {
      await ask(runtime, output(command), words.join(" "), options.surface);
    });

  program.command("search")
    .description("find the workflows and operations for a goal, ranked (= scalius_search)")
    .argument("<goal...>")
    .option("--limit <count>", "hits to return (1-10)")
    .addOption(surfaceOption())
    .action(async (words: string[], options: { limit?: string; surface: Audience }, command) => {
      await search(runtime, output(command), words.join(" "), options.surface, positiveInteger("limit", options.limit, 10));
    });

  program.command("describe")
    .description("how to call 1-5 operations: inputs, rules, one example (= scalius_describe)")
    .argument("<operationIds...>")
    .option("--full", "exact schemas", false)
    .option("--examples", "examples with optional fields", false)
    .action(async (ids: string[], options: { full: boolean; examples: boolean }, command) => {
      await describe(runtime, output(command), ids, options.full ? "full" : options.examples ? "examples" : "compact");
    });

  program.command("read")
    .description("run one read operation (= scalius_read); --all follows every page as NDJSON")
    .argument("<operationId>")
    .option("--input <json|@file|->", "{path, query, body} input")
    .option("--limit <count>", "rows per page (1-250)")
    .option("--cursor <cursor>", "meta.nextCursor from the previous page")
    .option("--all", "read every page, one record per line", false)
    .option("--ndjson", "print rows one JSON record per line", false)
    .option("--max-bytes <bytes>", "result budget per page (1024-65536)")
    .action(async (operationId: string, options: { input?: string; limit?: string; cursor?: string; all: boolean; ndjson: boolean; maxBytes?: string }, command) => {
      const maxBytes = positiveInteger("max-bytes", options.maxBytes, 65_536);
      if (maxBytes !== undefined && maxBytes < 1024) throw new CliError(2, "invalid_max_bytes", "--max-bytes must be from 1024 to 65536.");
      const out = output(command);
      const { select, ...rest } = out;
      await read(runtime, rest, operationId, {
        input: await readInput(runtime, options.input),
        ...(select ? { select } : {}),
        limit: positiveInteger("limit", options.limit, 250),
        cursor: options.cursor,
        maxBytes,
        all: options.all,
        ndjson: options.ndjson || options.all,
      });
    });

  program.command("write")
    .description("run one change (= scalius_write): --dry-run previews; gated changes need the merchant's approval")
    .argument("<operationId>")
    .option("--input <json|@file|->", "{path, query, body} input")
    .option("--dry-run", "validate and preview; writes nothing (exit 11)", false)
    .option("--yes", "you reviewed this change (a change the store gates still needs a person: a terminal prompt or the --approval link)", false)
    .option("--approval <id>", "the approval id the merchant approved in the dashboard (from the 428 answer)")
    .option("--idempotency-key <key>", "auto (default) or a key to reuse when retrying", "auto")
    .action(async (operationId: string, options: { input?: string; dryRun: boolean; yes: boolean; approval?: string; idempotencyKey: string }, command) => {
      const outcome = await write(runtime, output(command), operationId, {
        input: await readInput(runtime, options.input),
        dryRun: options.dryRun,
        yes: options.yes,
        approval: options.approval,
        idempotencyKey: options.idempotencyKey,
      });
      finish(outcome.code);
    });

  program.command("batch")
    .description("run up to 20 reads, or up to 20 changes in order, in one call")
    .requiredOption("--input <json|@file|->", "{\"steps\": [{\"id\", \"operationId\", \"input\"}]}")
    .option("--dry-run", "preview the changes; writes nothing (exit 11)", false)
    .option("--yes", "you reviewed this change (a change the store gates still needs a person: a terminal prompt or the --approval link)", false)
    .option("--approval <id>", "the approval id the merchant approved in the dashboard (from the 428 answer)")
    .action(async (options: { input: string; dryRun: boolean; yes: boolean; approval?: string }, command) => {
      const input = await readBatchInput(runtime, options.input);
      finish(await batch(runtime, output(command), input.body, options));
    });

  program.command("bulk")
    .description(`change many records at once: ${Object.keys(BULK_KINDS).join(", ")}`)
    .addArgument(new Argument("<kind>", "what to change").choices(Object.keys(BULK_KINDS)))
    .option("--ids <ids>", "comma-separated: SKU codes or ids (prices, stock), customer ids (tags) or product ids (status, publish)")
    .option("--filter <filter>", "instead of ids: key=value,key=value or JSON. Products: search, category, status, salesChannel. Customers: tag, minOrders, maxOrders")
    .option("--set <amount>", "prices: set every price to this amount in the store currency (1500 is 1,500.00 BDT in a taka store)")
    .option("--percent <n>", "prices: change every price by this percent (5 raises 5%, -10 lowers 10%)")
    .option("--amount <amount>", "prices: add (negative: take off) this amount in the store currency")
    .option("--minor", "prices: --set and --amount are minor units (150000 is 1,500.00 BDT), not the store currency", false)
    .option("--items <pairs>", "stock: sku=quantity,... the counted units on hand (a SKU code such as TS-RED-M, or its id)")
    .option("--quantity <n>", "stock: the count for every --ids SKU")
    .option("--location <id>", "stock: the location counted (the default one when omitted)")
    .option("--reason <text>", "stock: shown on each stock movement")
    .option("--add <tags>", "tags: comma-separated tags to add")
    .option("--remove <tags>", "tags: comma-separated tags to remove")
    .option("--status <status>", "status: active or draft")
    .option("--channels <ids>", "publish: comma-separated sales channel ids")
    .option("--action <action>", "publish: publish or unpublish")
    .option("--input <json|@file|->", "the raw {\"body\": {...}} instead of the friendly flags")
    .option("--dry-run", "preview before and after; writes nothing (exit 11)", false)
    .option("--yes", "you reviewed this change (a change the store gates still needs a person: a terminal prompt or the --approval link)", false)
    .option("--approval <id>", "the approval id the merchant approved in the dashboard (from the 428 answer)")
    .option("--wait", "follow a large run until it is done", false)
    .action(async (kind: string, options: Omit<BulkOptions, "input"> & { input?: string }, command) => {
      if (!(kind in BULK_KINDS)) throw new CliError(2, "invalid_bulk_kind", `Bulk kind must be one of: ${Object.keys(BULK_KINDS).join(", ")}.`);
      finish(await bulk(runtime, output(command), kind as BulkKind, {
        ...options,
        input: options.input ? await readInput(runtime, options.input) : undefined,
      }));
    });

  program.command("export")
    .description(`save a CSV export: ${Object.keys(EXPORT_KINDS).join(", ")}`)
    .argument("<kind>")
    .requiredOption("--out <file>", "destination file")
    .option("--since <date>", "first day, YYYY-MM-DD (store calendar)")
    .option("--until <date>", "last day, YYYY-MM-DD")
    .option("--report <id>", "report id (report exports)")
    .option("--query <json>", "more filters, as the export operation's query")
    .option("--max-rows <count>", "row cap")
    .option("--overwrite", "replace an existing file", false)
    .action(async (kind: string, options: { out: string; since?: string; until?: string; report?: string; query?: string; maxRows?: string; overwrite: boolean }, command) => {
      if (!(kind in EXPORT_KINDS)) throw new CliError(2, "invalid_export_kind", `Export kind must be one of: ${Object.keys(EXPORT_KINDS).join(", ")}.`);
      let query: Record<string, unknown> | undefined;
      if (options.query) {
        try {
          query = JSON.parse(options.query) as Record<string, unknown>;
        } catch {
          throw new CliError(2, "invalid_json", "--query must be a JSON object.");
        }
      }
      await exportArtifact(runtime, output(command), kind as ExportKind, {
        out: options.out,
        since: options.since,
        until: options.until,
        report: options.report,
        query,
        maxRows: positiveInteger("max-rows", options.maxRows, 100_000),
        overwrite: options.overwrite,
      });
    });

  // ─── Accounts and profiles ────────────────────────────────────────────────

  const auth = program.command("auth").description("authenticate the CLI");
  auth.command("login")
    .description("pair with a merchant dashboard or storefront audience")
    .requiredOption("--server <origin>", "Scalius API origin")
    .option("--profile-name <name>", "profile to create")
    .addOption(new Option("--resource <audience>", "credential audience").choices(["dashboard", "storefront"]).default("dashboard"))
    .option("--no-open", "do not open the browser")
    .action(async (options: { server: string; profileName?: string; open: boolean; resource: "dashboard" | "storefront" }, command) => {
      const profileName = options.profileName ?? globals(command).profile ?? "default";
      const result = await login(runtime, { server: options.server, profileName, openBrowser: options.open, resource: options.resource });
      writeResult(runtime, mode(command), result, `Authenticated profile '${profileName}'.`);
    });

  const token = auth.command("token").description("manage static credentials");
  token.command("import")
    .description("import a credential from SCALIUS_TOKEN, hidden prompt, or stdin")
    .requiredOption("--server <origin>", "Scalius API origin")
    .option("--profile-name <name>", "profile to create")
    .action(async (options: { server: string; profileName?: string }, command) => {
      const profileName = options.profileName ?? globals(command).profile ?? "default";
      const result = await importToken(runtime, options.server, profileName);
      writeResult(runtime, mode(command), result, `Authenticated profile '${profileName}'.`);
    });

  auth.command("status")
    .description("show local authentication status")
    .action(async (_options, command) => {
      writeResult(runtime, mode(command), await authStatus(runtime, globals(command).profile));
    });

  auth.command("logout")
    .description("remove the local credential without revoking it")
    .action(async (_options, command) => {
      const result = await logout(runtime, globals(command).profile);
      writeResult(runtime, mode(command), result, humanSummary(result));
    });

  auth.command("revoke")
    .description("revoke the current credential and remove it locally")
    .action(async (_options, command) => {
      const result = await revoke(runtime, globals(command).profile);
      writeResult(runtime, mode(command), result, humanSummary(result));
    });

  const profile = program.command("profile").description("manage server profiles");
  profile.command("list")
    .description("list profiles")
    .action(async (_options, command) => {
      writeResult(runtime, mode(command), await listProfiles(runtime));
    });
  profile.command("use")
    .description("select the active profile")
    .argument("<name>")
    .action(async (name: string, _options, command) => {
      writeResult(runtime, mode(command), await useProfile(runtime, name), `Active profile: ${name}`);
    });
  profile.command("show")
    .description("show a profile without revealing its credential")
    .argument("[name]")
    .action(async (name: string | undefined, _options, command) => {
      writeResult(runtime, mode(command), await showProfile(runtime, name ?? globals(command).profile));
    });

  // ─── Files and skills ─────────────────────────────────────────────────────

  const media = program.command("media").description("run guided media workflows");
  media.command("upload")
    .description("validate and upload one or more local media files")
    .argument("<files...>")
    .option("--folder-id <id>", "destination media folder")
    .option("--yes", "confirm the write", false)
    .action(async (files: string[], options: { folderId?: string; yes: boolean }, command) => {
      if (!options.yes) throw new CliError(10, "confirmation_required", "Media upload writes to the store. Re-run with --yes after reviewing the files.");
      const result = await uploadMediaFiles(runtime, await resolveForResource(command, "dashboard"), files, options.folderId);
      writeResult(runtime, mode(command), result);
    });

  const skill = program.command("skill").description("install the bundled Scalius agent skills");
  skill.command("install")
    .description("install or update the Agent Skills suite for one harness")
    .option("--harness <name>", `agent harness (${AGENT_HARNESSES.join("|")})`, "agents")
    .option("--force", "replace an existing Scalius skill suite", false)
    .action(async (options: { harness: string; force: boolean }, command) => {
      if (!AGENT_HARNESSES.includes(options.harness as AgentHarness)) {
        throw new CliError(2, "invalid_harness", `Harness must be one of: ${AGENT_HARNESSES.join(", ")}.`);
      }
      const result = await installSkill(runtime, options.harness as AgentHarness, options.force);
      const count = Array.isArray(result.skills) ? result.skills.length : 0;
      writeResult(runtime, mode(command), result, `${String(result.status)} ${String(count)} Scalius skills in ${String(result.root)}`);
    });

  // ─── Compatibility (0.2 commands) ─────────────────────────────────────────

  program.command("setup")
    .description("install the skills and print MCP setup commands (use init instead)")
    .requiredOption("--harness <name>", `agent harness (${AGENT_HARNESSES.join("|")})`)
    .option("--server <origin>", "Scalius API origin; otherwise use the selected profile")
    .option("--force", "replace an existing Scalius skill", false)
    .action(async (options: { harness: string; server?: string; force: boolean }, command) => {
      if (!AGENT_HARNESSES.includes(options.harness as AgentHarness)) {
        throw new CliError(2, "invalid_harness", `Harness must be one of: ${AGENT_HARNESSES.join(", ")}.`);
      }
      const existing = options.server ? undefined : await resolve(command, false).catch(() => undefined);
      const result = await setupHarness(runtime, {
        harness: options.harness as AgentHarness,
        force: options.force,
        server: options.server ?? existing?.server,
      });
      writeResult(runtime, mode(command), result, JSON.stringify(result, null, 2));
    });

  const workflow = program.command("workflow").description("resolve goals locally (use search and ask)");
  workflow.command("resolve")
    .description("resolve one goal into the smallest reviewed operation plan")
    .argument("<request>", "merchant or buyer goal")
    .addOption(new Option("--surface <audience>", "workflow audience").choices(["dashboard", "storefront"]).default("dashboard"))
    .action(async (request: string, options: { surface: "dashboard" | "storefront" }, command) => {
      const document = await loadOpenApi(runtime, await resolve(command, false));
      const result = resolveWorkflow(document, { prompt: request, surface: options.surface });
      writeResult(runtime, mode(command), result, JSON.stringify(result, null, 2));
    });
  workflow.command("read")
    .description("answer one supported store-data question through fixed reviewed reads")
    .argument("<request>", "merchant or buyer data question")
    .addOption(new Option("--surface <audience>", "workflow audience").choices(["dashboard", "storefront"]).default("dashboard"))
    .action(async (request: string, options: { surface: "dashboard" | "storefront" }, command) => {
      const profileValue = await resolveForResource(command, options.surface);
      const document = await loadOpenApi(runtime, profileValue);
      const result = await readWorkflow(runtime, profileValue, document, { prompt: request, surface: options.surface });
      const human = result.kind === "result"
        ? `${result.workflowId}\n${JSON.stringify(result.outputs, null, 2)}`
        : `${result.classification.reason} Use scalius search for ranked options.`;
      writeResult(runtime, mode(command), result, human);
    });

  const operations = program.command("operations").alias("ops").description("low-level REST lane: files, artifacts and continuations");
  operations.command("refresh")
    .description("refresh the cached live operation contract")
    .addOption(new Option("--surface <audience>", "operation audience").choices(["dashboard", "storefront"]).default("dashboard"))
    .action(async (options: { surface: "dashboard" | "storefront" }, command) => {
      const result = await operationsRefresh(runtime, await resolveForResource(command, options.surface));
      writeResult(runtime, mode(command), result, `Refreshed ${String(result.operationCount)} ${options.surface} operation(s).`);
    });
  operations.command("search")
    .description("search the live operation contract by keyword")
    .argument("[query]")
    .option("--limit <count>", "maximum results (1-100)", "20")
    .addOption(new Option("--surface <audience>", "operation audience").choices(["dashboard", "storefront"]))
    .action(async (query: string | undefined, options: { limit: string; surface?: "dashboard" | "storefront" }, command) => {
      const limit = Number(options.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new CliError(2, "invalid_limit", "Search limit must be an integer from 1 to 100.");
      }
      const profileValue = options.surface
        ? await resolveForResource(command, options.surface)
        : globals(command).profile
          ? await resolve(command)
          : await resolveForResource(command, "dashboard");
      const result = await operationsSearch(runtime, profileValue, query, limit);
      writeResult(runtime, mode(command), result, operationSearchSummary(result));
    });
  operations.command("describe")
    .description("describe one executable or continuation operation from the contract")
    .argument("<operationId>")
    .option("--full", "include every response schema", false)
    .action(async (id: string, options: { full: boolean }, command) => {
      const result = await operationsDescribe(runtime, await resolveForResource(command, resourceForOperationId(id)), id, options.full);
      writeResult(runtime, mode(command), result, `${id}\n${JSON.stringify(result, null, 2)}`);
    });
  operations.command("run")
    .description("run one operation over REST (file uploads, artifacts, continuations)")
    .argument("<operationId>")
    .option("--input <json|@file|->", "structured path/query/body input")
    .option("--file <path|field=@path>", "stream a reviewed raw file or attach a multipart field", collectFile, [])
    .option("--idempotency-key <key>", "idempotency key for a supporting operation")
    .option("--yes", "confirm local risk warning", false)
    .option("--approval <id>", "the approval id the merchant approved in the dashboard (from the 428 answer)")
    .option("--save <path>", "save a contract-declared artifact response")
    .option("--overwrite", "replace an existing --save destination", false)
    .action(async (id: string, options: RunOptions, command) => {
      const input = await readInput(runtime, options.input);
      const result = await operationsRun(runtime, await resolveForResource(command, resourceForOperationId(id)), id, {
        input,
        files: options.file,
        idempotencyKey: options.idempotencyKey,
        yes: options.yes,
        approval: options.approval,
        save: options.save,
        overwrite: options.overwrite,
      });
      writeResult(runtime, mode(command), result, operationResultSummary(result as unknown as Record<string, unknown>));
    });
  operations.command("batch")
    .description("execute a bounded sequential operation batch over REST")
    .requiredOption("--input <json|@file|->", "batch input")
    .option("--yes", "confirm local risk warnings", false)
    .action(async (options: { input: string; yes: boolean }, command) => {
      const input = await readBatchInput(runtime, options.input);
      const result = await operationsBatch(runtime, await resolveForResource(command, resourceForBatch(input)), input, options.yes);
      writeResult(runtime, mode(command), result, `Completed ${String(result.count)} batch step(s).\n${JSON.stringify(result.results, null, 2)}`);
    });

  return program;
}

function argvOutput(argv: readonly string[]): string | undefined {
  const index = argv.lastIndexOf("--output");
  if (index >= 0) return argv[index + 1];
  const inline = [...argv].reverse().find((value) => value.startsWith("--output="));
  return inline?.slice("--output=".length);
}

export async function runProgram(runtime: Runtime, argv: string[]): Promise<number> {
  const program = createProgram(runtime);
  let mode: OutputMode = resolveOutputMode(runtime, argvOutput(argv));
  if ((argv.includes("--help") || argv.includes("-h")) && argv.includes("--json")) {
    runtime.stdout.write(`${JSON.stringify(commandTree(program, argv))}\n`);
    return 0;
  }
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof ExitSignal) return error.code;
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      const cliError = new CliError(2, "usage_error", error.message);
      writeError(runtime, mode, cliError);
      return cliError.exitCode;
    }
    const cliError = asCliError(error);
    try {
      mode = resolveOutputMode(runtime, (program.opts() as GlobalOptions).output ?? argvOutput(argv));
    } catch {
      // Retain the argument-derived mode.
    }
    writeError(runtime, mode, cliError);
    return cliError.exitCode;
  }
}
