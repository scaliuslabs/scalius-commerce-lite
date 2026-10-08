// Theme operations through real MCP dispatch on D1: commands answer small
// revision receipts, history pages stay under the 64 KiB result ceiling at
// their worst case, and whole documents arrive only as an encrypted artifact.
import "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { DEFAULT_STOREFRONT_THEME, THEME_VERSION_CHANGES_MAX, storefrontSectionDefault } from "@scalius/shared/storefront-theme";
import { buildAgentOperationManifest, type AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";
import type { AgentOAuthProps, AgentPrincipal } from "./types";

const state = vi.hoisted(() => ({ operations: [] as AgentOperationManifestEntry[], principal: null as AgentPrincipal | null, props: null as AgentOAuthProps | null }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("agents/mcp/server", () => ({ createMcpHandler: vi.fn(), getMcpAuthContext: () => ({ props: state.props }) }));
vi.mock("./principal", () => ({ resolveAgentPrincipalFromBearer: vi.fn(async () => state.principal), resolveAgentPrincipalFromGrant: vi.fn(async () => state.principal) }));
vi.mock("./backend", () => ({ loadAgentAccessBackend: vi.fn(async () => ({ resolvePrincipal: vi.fn(async () => state.principal), authorizeOperation: vi.fn(async () => true), writeAudit: vi.fn(async () => undefined) })) }));
// Contract-derived discovery keeps this integration check valid before SDK regeneration.
vi.mock("./mcp/operations", () => ({
  getAuthorizedOperation: vi.fn(async (id: string) => state.operations.find((operation) => operation.operationId === id) ?? null),
  listAuthorizedOperations: vi.fn(async () => state.operations), summarizeOperation: vi.fn((operation: AgentOperationManifestEntry) => operation), describeOperation: vi.fn((operation: AgentOperationManifestEntry) => operation),
}));
vi.mock("./direct-operation", () => ({ resolveDirectAgentOperation: (method: string, path: string) => state.operations.find((operation) => operation.method === method && operation.pathTemplate === path) ?? null }));

import app from "../app";
import { finalizeOpenApiContract } from "../openapi-contract";
import { createAgentMcpServer } from "./mcp/server";
import { openAgentArtifact } from "./artifacts";

const OWNER = "00000000-0000-4000-8000-000000000001";
const GRANT = "agr_0123456789abcdefghij";
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const measured = { maxReceiptBytes: 0, maxVersionPageBytes: 0, artifactBytes: 0 };

function largePage() {
  return {
    title: "ঈদ প্রচারণা", description: "ঈদের উপহার, সারা দেশে ডেলিভারি।",
    sections: Array.from({ length: 7 }, (_, index) => ({
      ...storefrontSectionDefault("faq", `faq-${index}`), type: "faq" as const,
      settings: { heading: "সাধারণ প্রশ্ন", items: Array.from({ length: 20 }, () => ({ question: "অফার?", answer: "বাংলা".repeat(200) })) },
    })),
  };
}

/** The largest history metadata the schema admits: every string at its bound, the note all JSON-escaped control characters. */
function worstCaseMeta() {
  const page = `landing/${"a".repeat(100)}`;
  return {
    changes: Array.from({ length: THEME_VERSION_CHANGES_MAX }, (_, index) => ({
      kind: "section-changed", page, sectionId: `s${String(index).padStart(39, "0")}`, sectionType: "x".repeat(32),
    })),
    moreChanges: 999,
    note: "\u0000".repeat(500),
  };
}

describe("theme operations through real MCP dispatch and D1", () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let objects: Map<string, ArrayBuffer>;
  let server: ReturnType<typeof createAgentMcpServer>;

  // The whole contract, once: building it is the slow part (under a full suite's load too).
  beforeAll(() => {
    state.operations = buildAgentOperationManifest(finalizeOpenApiContract(app.getOpenAPIDocument({ openapi: "3.0.0", info: { title: "Theme MCP", version: "test" } })));
  }, 120_000);

  // A store with 20 published versions of a 400+ KiB document (about 9 MB of rows).
  beforeEach(() => {
    state.principal = { kind: "agent", grantId: GRANT, credentialId: null, ownerUserId: OWNER, isSuperAdmin: false, resource: "dashboard", grantKind: "oauth", preset: "full", permissions: new Set(["settings.general.view", "settings.general.edit"]), riskCeiling: "destructive", authorityRevision: 1, expiresAt: new Date(Date.now() + 3600_000) };
    state.props = { grantId: GRANT, ownerUserId: OWNER, resource: "dashboard", permissions: [...state.principal.permissions], riskCeiling: "destructive", audience: ["https://api.example.test/api/v1/mcp/dashboard"] };
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    // A long Bangla name: the history bounds what it returns.
    sqlite.prepare("INSERT INTO user (id,name,email) VALUES (?,?,'owner@example.test')").run(OWNER, "বাংলা".repeat(80));
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO agent_grants (id,kind,owner_user_id,resource,label,oauth_client_id,oauth_redirect_uris_json,preset,permissions_json,risk_ceiling,authority_revision,status,expires_at,created_at,updated_at) VALUES (?,'oauth',?,'dashboard','Themes','theme-test-client','[]','full','[\"settings.general.view\",\"settings.general.edit\"]','destructive',1,'active',?,?,?)").run(GRANT, OWNER, now + 3600, now, now);
    const theme = JSON.stringify(DEFAULT_STOREFRONT_THEME);
    sqlite.prepare("INSERT INTO theme_settings (id,colors,revision) VALUES ('default',?,20)").run(theme);
    sqlite.prepare("INSERT INTO theme_settings_drafts (id,theme,revision,base_published_revision) VALUES ('default',?,1,20)").run(theme);
    const large = { ...structuredClone(DEFAULT_STOREFRONT_THEME), pages: { ...structuredClone(DEFAULT_STOREFRONT_THEME.pages), landing: { eid: largePage() } } };
    expect(bytes(large)).toBeGreaterThan(400_000);
    expect(bytes(large)).toBeLessThan(512 * 1024);
    const snapshot = JSON.stringify({ meta: worstCaseMeta(), theme: large });
    const insertVersion = sqlite.prepare("INSERT INTO theme_settings_versions (id,published_revision,theme,source,published_by) VALUES (?, ?, ?, 'publish', ?)");
    for (let revision = 1; revision <= 20; revision += 1) insertVersion.run(`themev_${"v".repeat(120)}_${revision}`, revision, snapshot, OWNER);
    objects = new Map();
    env = {
      DB: harness.binding, PUBLIC_API_BASE_URL: "https://api.example.test", STOREFRONT_URL: "https://storefront.example.test", SCALIUS_SECRET: "theme-mcp-test-master-secret-0123456789", AGENT_TOKEN_PEPPER: "test-pepper", RL_STANDARD: { limit: vi.fn(async () => ({ success: true })) },
      BUCKET: { put: vi.fn(async (key: string, value: BodyInit) => { objects.set(key, await new Response(value).arrayBuffer()); return { key }; }), get: vi.fn(async (key: string) => { const value = objects.get(key); return value ? { arrayBuffer: async () => value, size: value.byteLength } : null; }), delete: vi.fn(async (key: string) => { objects.delete(key); }) },
    } as unknown as Env;
    server = createAgentMcpServer({ surface: "dashboard", env, ctx: { props: state.props, waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext });
  }, 60_000);
  afterEach(() => sqlite.close());
  afterAll(() => process.stdout.write(`Theme MCP measured bytes ${JSON.stringify(measured)}\n`));

  async function call(mode: "read" | "write", operationId: string, input: unknown = {}) {
    const handler = Reflect.get(server, "_registeredTools")[`operations.${mode}`].handler;
    const result = await handler({ operationId, input });
    expect(result, operationId).not.toHaveProperty("isError");
    expect(result.structuredContent, operationId).toMatchObject({ ok: true });
    const size = bytes(result.structuredContent);
    expect(size).toBeLessThan(65_536);
    if (operationId === "dashboard.theme.versions_list") measured.maxVersionPageBytes = Math.max(measured.maxVersionPageBytes, size);
    else if (operationId !== "dashboard.theme.document_get") {
      expect(size, operationId).toBeLessThan(operationId === "dashboard.theme.workspace_get" ? 16_384 : 4096);
      measured.maxReceiptBytes = Math.max(measured.maxReceiptBytes, size);
    }
    return result.structuredContent.result;
  }

  it("drafts a large Bangla landing page with a small receipt and verifies it by rereading the workspace", async () => {
    const before = await call("read", "dashboard.theme.workspace_get");
    expect(before.data.data).toMatchObject({ published: { revision: 20 }, draft: { revision: 1, basePublishedRevision: 20 }, landingPages: [] });
    const saved = await call("write", "dashboard.theme.page_draft_update", { body: { page: "landing", slug: "eid", value: largePage(), expectedDraftRevision: 1, basePublishedRevision: 20 } });
    expect(saved.data.data).toMatchObject({ revision: 2, basePublishedRevision: 20 });
    expect(saved).not.toHaveProperty("artifact");
    expect(objects.size).toBe(0);
    const after = await call("read", "dashboard.theme.workspace_get");
    expect(after.data.data).toMatchObject({
      published: { revision: 20 }, draft: { revision: 2 }, draftDiffersFromLive: true,
      landingPages: [{ slug: "eid", title: "ঈদ প্রচারণা", sections: 7 }],
    });
    // A stale revision conflicts instead of overwriting.
    const handler = Reflect.get(server, "_registeredTools")["operations.write"].handler;
    const stale = await handler({ operationId: "dashboard.theme.page_draft_update", input: { body: { page: "landing", slug: "eid", value: null, expectedDraftRevision: 1, basePublishedRevision: 20 } } });
    expect(JSON.stringify(stale)).toContain("409");
  });

  it("pages all 20 worst-case versions under the result ceiling and keeps restore, save, publish and discard receipts small", async () => {
    const revisions: number[] = [];
    let beforeRevision: number | undefined;
    do {
      const result = await call("read", "dashboard.theme.versions_list", { query: beforeRevision ? { beforeRevision } : {} });
      const page = result.data.data;
      expect(page.versions).toHaveLength(5);
      expect(page.versions[0]).not.toHaveProperty("theme");
      expect(page.versions[0].publishedByName).toHaveLength(200);
      revisions.push(...page.versions.map((version: { revision: number }) => version.revision));
      beforeRevision = page.nextBeforeRevision ?? undefined;
    } while (beforeRevision);
    expect(revisions).toEqual(Array.from({ length: 20 }, (_, index) => 20 - index));
    await call("write", "dashboard.theme.version_restore", { body: { sourceRevision: 1, expectedDraftRevision: 1, basePublishedRevision: 20 } });
    const workspace = await call("read", "dashboard.theme.workspace_get");
    expect(workspace.data.data).toMatchObject({ published: { revision: 20 }, draft: { revision: 2, basePublishedRevision: 20 } });
    expect(workspace.data.data.draft).not.toHaveProperty("theme");
    const theme = JSON.parse((sqlite.prepare("SELECT theme FROM theme_settings_drafts").get() as { theme: string }).theme);
    await call("write", "dashboard.theme.draft_save", { body: { theme, expectedDraftRevision: 2, basePublishedRevision: 20 } });
    const published = await call("write", "dashboard.theme.publish", { body: { expectedPublishedRevision: 20, expectedDraftRevision: 3, note: "বাংলা".repeat(100) } });
    expect(published.data.data).toMatchObject({ published: { revision: 21 }, draft: { revision: 4, basePublishedRevision: 21 } });
    const discarded = await call("write", "dashboard.theme.draft_discard", { body: { expectedDraftRevision: 4, basePublishedRevision: 21 } });
    expect(discarded.data.data).toMatchObject({ published: { revision: 21 }, draft: { revision: 5 } });
    expect(objects.size).toBe(0);
  });

  it("delivers a large version's whole document as an encrypted JSON artifact", async () => {
    const result = await call("read", "dashboard.theme.document_get", { query: { source: "version", revision: 1 } });
    // The MCP formatter deliberately strips data:null from artifact metadata.
    expect(result).not.toHaveProperty("data");
    expect(result.artifact).toMatchObject({ mediaType: "application/json", filename: "theme-version-1.json", sizeBytes: expect.any(Number) });
    expect(result.artifact.sizeBytes).toBeGreaterThan(400_000);
    expect(result.artifact.sizeBytes).toBeLessThan(1024 * 1024);
    measured.artifactBytes = result.artifact.sizeBytes;
    const [key, encrypted] = [...objects][0]!;
    const decoded = JSON.parse(new TextDecoder().decode(await openAgentArtifact(env, key, encrypted)));
    expect(decoded.data).toMatchObject({ source: "version", revision: 1 });
    expect(decoded.data.document.pages.landing.eid).toEqual(largePage());
    expect(decoded.data.document.tokens).toEqual(DEFAULT_STOREFRONT_THEME.tokens);
  });
});
