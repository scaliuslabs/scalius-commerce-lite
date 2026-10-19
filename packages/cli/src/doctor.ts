import { ConfigStore } from "./config.js";
import { CliError, type CliExitCode } from "./errors.js";
import { fetchWithNetworkErrors } from "./http.js";
import { checkHarness, detectHarnesses, type HarnessCheck, type InitHarness } from "./harness.js";
import { mcpPath, mcpRequest, type Audience } from "./mcp-client.js";
import { MCP_SERVER_NAMES, launchCommand, type McpServerEntry } from "./plugin.js";
import type { ResolvedProfile, Runtime } from "./types.js";
import { packageVersion } from "./version.js";

// `scalius doctor`: every link between the merchant's agent and the store,
// checked in order, each failure with the one command that fixes it.

export const MCP_TOOL_NAMES = ["scalius_search", "scalius_describe", "scalius_answer", "scalius_read", "scalius_write"] as const;
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1_000;

export interface DoctorCheck extends HarnessCheck {
  exitCode?: CliExitCode;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  server?: string;
  profile?: string;
  store?: Record<string, unknown>;
  checks: DoctorCheck[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeCheck(): DoctorCheck {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const supported = major > 22 || (major === 22 && minor >= 12);
  return supported
    ? { id: "cli", status: "ok", detail: `scalius ${packageVersion()} on Node ${process.versions.node}` }
    : { id: "cli", status: "fail", detail: `Node ${process.versions.node} is older than 22.12.`, fix: "Install Node 22.12 or newer.", exitCode: 2 };
}

async function serverCheck(runtime: Runtime, profile: ResolvedProfile, audience: Audience): Promise<DoctorCheck> {
  const url = `${profile.server}/.well-known/oauth-protected-resource${mcpPath(audience)}`;
  try {
    const response = await fetchWithNetworkErrors(runtime, url, { headers: { Accept: "application/json" }, redirect: "error", signal: runtime.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        id: "server",
        status: "fail",
        detail: `${profile.server} answered HTTP ${response.status} for its agent access metadata.`,
        fix: response.status === 404 ? "Deploy a Scalius API with agent access, or check the --server origin." : "Check the store API origin and its deployment.",
        exitCode: 8,
      };
    }
    const metadata = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { id: "server", status: "ok", detail: `${profile.server} serves ${typeof metadata.resource === "string" ? metadata.resource : mcpPath(audience)}` };
  } catch (error) {
    return {
      id: "server",
      status: "fail",
      detail: `${profile.server} is unreachable: ${error instanceof Error ? error.message : "network error"}.`,
      fix: "Check the network and the --server origin.",
      exitCode: 7,
    };
  }
}

function credentialCheck(runtime: Runtime, profile: ResolvedProfile, audience: Audience): DoctorCheck {
  if (!profile.token) {
    return { id: "credential", status: "fail", detail: `Profile '${profile.name}' has no ${audience} credential.`, fix: `scalius init --server ${profile.server}`, exitCode: 3 };
  }
  const expiresAt = profile.credential?.expiresAt;
  const left = expiresAt ? Date.parse(expiresAt) - runtime.now() : Number.POSITIVE_INFINITY;
  if (left <= 0) {
    return { id: "credential", status: "fail", detail: `The ${audience} credential expired at ${expiresAt}.`, fix: `scalius auth login --server ${profile.server}`, exitCode: 3 };
  }
  const source = profile.tokenSource === "environment" ? "SCALIUS_TOKEN" : `profile '${profile.name}'`;
  if (left < EXPIRY_WARNING_MS) {
    return { id: "credential", status: "warn", detail: `The ${audience} credential (${source}) expires at ${expiresAt}.`, fix: `scalius auth login --server ${profile.server}` };
  }
  return { id: "credential", status: "ok", detail: `${audience} credential from ${source}${expiresAt ? `, expires ${expiresAt}` : ""}` };
}

async function mcpChecks(runtime: Runtime, profile: ResolvedProfile, audience: Audience): Promise<{ checks: DoctorCheck[]; store?: Record<string, unknown> }> {
  let tools: string[];
  try {
    const listed = await mcpRequest(runtime, profile, audience, "tools/list", {}, { retry: true, maxAttempts: 2 });
    tools = Array.isArray(listed.tools) ? listed.tools.filter(isRecord).map((tool) => String(tool.name)) : [];
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError(8, "mcp_failed", "The MCP endpoint failed.");
    return {
      checks: [{
        id: "mcp",
        status: "fail",
        detail: cliError.message,
        fix: cliError.envelope.hint ?? (cliError.exitCode === 3 ? `scalius auth login --server ${profile.server}` : "Check the store API deployment."),
        exitCode: cliError.exitCode,
      }],
    };
  }
  const missing = MCP_TOOL_NAMES.filter((name) => !tools.includes(name));
  const checks: DoctorCheck[] = [missing.length === 0
    ? { id: "mcp", status: "ok", detail: `MCP ${mcpPath(audience)}: ${MCP_TOOL_NAMES.length} scalius tools` }
    : {
      id: "mcp",
      status: "fail",
      detail: `The store's MCP server lacks ${missing.join(", ")} (it is older than this CLI).`,
      fix: "Deploy the latest Scalius API, or use a CLI version that matches it.",
      exitCode: 8,
    }];
  if (missing.length > 0 || audience !== "dashboard") return { checks };
  try {
    const resource = await mcpRequest(runtime, profile, audience, "resources/read", { uri: "scalius://store" }, { retry: true, maxAttempts: 2 });
    const contents = Array.isArray(resource.contents) ? resource.contents.filter(isRecord) : [];
    const store = JSON.parse(String(contents[0]?.text ?? "{}")) as Record<string, unknown>;
    const facts = [store.name, store.currency, store.timeZone].filter((value) => typeof value === "string").join(" · ");
    const notSetUp = Array.isArray(store.notSetUp) ? store.notSetUp.map(String) : [];
    checks.push(notSetUp.length > 0
      ? { id: "store", status: "warn", detail: `${facts || "Store"}; not set up: ${notSetUp.join("; ")}`, fix: "Ask your agent: what is left to set up before launch?" }
      : { id: "store", status: "ok", detail: facts || "Store context readable" });
    return { checks, store };
  } catch (error) {
    checks.push({ id: "store", status: "warn", detail: `Store context unavailable: ${error instanceof Error ? error.message : "error"}` });
    return { checks };
  }
}

export interface DoctorOptions {
  profile?: string;
  audience?: Audience;
  harnesses?: InitHarness[];
  /** Skip the harness checks (init runs them after registering). */
  skipHarnesses?: boolean;
}

export async function runDoctor(runtime: Runtime, options: DoctorOptions = {}): Promise<DoctorReport> {
  const audience = options.audience ?? "dashboard";
  const checks: DoctorCheck[] = [nodeCheck()];
  let profile: ResolvedProfile | undefined;
  try {
    profile = await new ConfigStore(runtime).resolveProfileForResource(audience, options.profile, false);
  } catch (error) {
    checks.push({
      id: "profile",
      status: "fail",
      detail: error instanceof Error ? error.message : "No profile is configured.",
      fix: "scalius init --server https://<your-store-api>",
      exitCode: 3,
    });
  }
  const report: DoctorReport = { ok: false, version: packageVersion(), checks };
  if (profile) {
    report.server = profile.server;
    report.profile = profile.name;
    checks.push({ id: "profile", status: "ok", detail: `profile '${profile.name}' -> ${profile.server}` });
    const server = await serverCheck(runtime, profile, audience);
    checks.push(server);
    const credential = credentialCheck(runtime, profile, audience);
    checks.push(credential);
    if (server.status !== "fail" && credential.status !== "fail") {
      const mcp = await mcpChecks(runtime, profile, audience);
      checks.push(...mcp.checks);
      if (mcp.store) report.store = mcp.store;
    }
  }
  if (!options.skipHarnesses) {
    const harnesses = options.harnesses ?? await detectHarnesses(runtime);
    const servers: McpServerEntry[] = [{ audience, name: MCP_SERVER_NAMES[audience], launch: launchCommand(runtime, audience, profile?.name) }];
    for (const harness of harnesses) {
      const check = await checkHarness(runtime, harness, servers);
      checks.push({ ...check, ...(check.status === "fail" ? { exitCode: 5 as const } : {}) });
    }
  }
  report.ok = checks.every((check) => check.status !== "fail");
  return report;
}

export function doctorExitCode(report: DoctorReport): number {
  return report.checks.find((check) => check.status === "fail")?.exitCode ?? (report.ok ? 0 : 8);
}

export function renderDoctor(report: DoctorReport): string {
  const label = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" } as const;
  const lines = report.checks.map((check) => {
    const fix = check.fix && check.status !== "ok" ? `\n        fix: ${check.fix}` : "";
    return `  ${label[check.status]}  ${check.id.padEnd(16)} ${check.detail}${fix}`;
  });
  return [`Scalius doctor (${report.ok ? "ready" : "needs attention"})`, ...lines].join("\n");
}
