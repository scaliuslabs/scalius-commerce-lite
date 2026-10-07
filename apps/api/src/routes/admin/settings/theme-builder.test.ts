// The theme builder's routes over a migrated database: AI drafting through a
// fake app AI provider, drafted sections, restore points.
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ProviderError } from "@scalius/shared/plugins/providers";
import { DEFAULT_STOREFRONT_THEME, storefrontTemplateTheme } from "@scalius/shared/storefront-theme";
import { errorResponseFromError } from "../../../utils/api-response";
import { themeBuilderRoutes } from "./theme-builder";

const plugins = vi.hoisted(() => ({ active: [] as unknown[] }));
vi.mock("@scalius/core/modules/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/plugins")>()),
  listActiveProviderPlugins: vi.fn(async () => plugins.active),
}));

const fake = vi.hoisted(() => ({
  generate: vi.fn(),
  issue: null as string | null,
  asked: [] as Array<{ kind: string; id: string }>,
}));
vi.mock("../../../plugins/providers/app-providers", () => ({
  requestAppProviders: () => ({
    resolve: async (kind: string, id: string) => {
      fake.asked.push({ kind, id });
      return fake.issue
        ? { provider: null, issue: fake.issue }
        : { provider: { id, label: "Acme AI", generate: fake.generate }, issue: null };
    },
  }),
}));

function createApp() {
  const { sqlite, db } = createSqliteD1Database();
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("user" as never, { id: "user_1" } as never);
    await next();
  });
  app.route("/admin/settings", themeBuilderRoutes);
  const call = (path: string, init: { method?: string; body?: unknown } = {}) => app.request(`/api/v1/admin/settings${path}`, {
    method: init.method ?? "GET",
    ...(init.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
  }, {} as unknown as Env);
  return { call, sqlite };
}

const faq = { type: "faq", settings: { heading: "Questions", items: [{ question: "Shipping?", answer: "Two days." }] } };
const request = { providerId: "acme.ai:writer", prompt: "A FAQ about delivery", page: "home" };

beforeEach(() => {
  fake.generate.mockReset();
  fake.issue = null;
  fake.asked = [];
  plugins.active = [];
  // The AI helper logs masked failure metadata; keep the test output clean.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("POST /theme/ai-draft", () => {
  it("asks the chosen provider for purpose theme.sections with a JSON Schema and the prompt", async () => {
    fake.generate.mockResolvedValue({ value: { sections: [faq], note: "Check the answers." } });
    const { call } = createApp();
    const response = await call("/theme/ai-draft", { method: "POST", body: { ...request, locale: "bn", limit: 2 } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fake.asked).toEqual([{ kind: "ai", id: "acme.ai:writer" }]);

    const [input] = fake.generate.mock.calls[0]!;
    expect(input).toMatchObject({ version: 1, purpose: "theme.sections", prompt: "A FAQ about delivery", locale: "bn" });
    expect(input.instructions).toContain("at most 2 storefront sections for the homepage");
    expect(input.schema).toMatchObject({ type: "object", required: ["sections"], properties: { sections: { type: "array", maxItems: 2 } } });
    const types = (input.schema.properties.sections.items.anyOf as Array<{ properties: { type: { const: string } } }>).map((each) => each.properties.type.const);
    expect(types).toContain("faq");
    expect(types).not.toContain("app");
  });

  it("returns valid sections marked as AI drafts, drops invalid and app ones, and counts them", async () => {
    fake.generate.mockResolvedValue({
      value: {
        sections: [
          faq,
          { type: "faq", settings: { heading: "", items: [{ question: "", answer: "" }] } },
          { type: "app", version: 1, settings: { app: "acme.shop/widget", values: {} } },
        ],
      },
    });
    const { call } = createApp();
    const response = await call("/theme/ai-draft", { method: "POST", body: request });
    const body = await response.json() as { data: { sections: Array<{ id: string; type: string; aiDraft?: boolean }>; rejected: number; note: string | null } };
    expect(body.data.sections).toHaveLength(1);
    expect(body.data.sections[0]).toMatchObject({ id: "faq", type: "faq", aiDraft: true });
    expect(body.data.rejected).toBe(2);
    expect(body.data.note).toBeNull();
  });

  it("takes only as many sections as the limit", async () => {
    fake.generate.mockResolvedValue({ value: { sections: [faq, faq, faq] } });
    const { call } = createApp();
    const response = await call("/theme/ai-draft", { method: "POST", body: { ...request, limit: 2 } });
    const body = await response.json() as { data: { sections: Array<{ id: string }>; rejected: number } };
    expect(body.data.sections.map((section) => section.id)).toEqual(["faq", "faq-2"]);
  });

  it("refuses a value that is not a draft with a plain message and the ai.invalid_output code", async () => {
    const { call } = createApp();
    for (const value of ["just words", { sections: "no" }, { nothing: true }]) {
      fake.generate.mockResolvedValue({ value });
      const response = await call("/theme/ai-draft", { method: "POST", body: request });
      expect(response.status, JSON.stringify(value)).toBe(400);
      const body = await response.json() as { error: { message: string; details: { code: string } } };
      expect(body.error.message).toMatch(/^Acme AI gave an answer that does not fit \(.+\)\. Nothing was added\. Try other words\.$/);
      expect(body.error.details).toEqual({ code: "ai.invalid_output" });
    }
  });

  it("refuses a draft with no valid section, naming none of the provider's text", async () => {
    const { call } = createApp();
    for (const value of [{ sections: [] }, { sections: [{ type: "nope", settings: {} }] }]) {
      fake.generate.mockResolvedValue({ value });
      const response = await call("/theme/ai-draft", { method: "POST", body: request });
      expect(response.status, JSON.stringify(value)).toBe(400);
      const body = await response.json() as { error: { message: string; details: { code: string } } };
      expect(body.error.message).toBe("Acme AI returned nothing this theme can show. Try other words.");
      expect(body.error.details).toEqual({ code: "ai.invalid_output" });
    }
  });

  it("surfaces a provider's own safe message, and a plain one for any other failure", async () => {
    const { call } = createApp();
    fake.generate.mockRejectedValue(new ProviderError("auth", "The API key was refused."));
    const refused = await call("/theme/ai-draft", { method: "POST", body: request });
    expect(refused.status).toBe(400);
    const refusedBody = await refused.json() as { error: { message: string; details: { code: string } } };
    expect(refusedBody.error.message).toBe("Acme AI: The API key was refused.");
    expect(refusedBody.error.details).toEqual({ code: "ai.provider" });

    fake.generate.mockRejectedValue(new Error("socket hang up with secret-token-123"));
    const failed = await call("/theme/ai-draft", { method: "POST", body: request });
    expect(failed.status).toBe(400);
    const text = JSON.stringify(await failed.json());
    expect(text).toContain("Acme AI could not answer. Try again.");
    expect(text).not.toContain("secret-token-123");
  });

  it("tells the merchant why a provider cannot run, without calling it", async () => {
    fake.issue = "Add the API key in the app's settings.";
    const { call } = createApp();
    const response = await call("/theme/ai-draft", { method: "POST", body: request });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { message: string } }).error.message).toBe("Add the API key in the app's settings.");
    expect(fake.generate).not.toHaveBeenCalled();
  });

  it("refuses an unknown page, an empty prompt, a limit past eight and extra keys before any call", async () => {
    const { call } = createApp();
    for (const bad of [
      { ...request, page: "checkout" },
      { ...request, prompt: "   " },
      { ...request, limit: 9 },
      { ...request, locale: "english" },
      { ...request, extra: true },
    ]) {
      expect((await call("/theme/ai-draft", { method: "POST", body: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(fake.generate).not.toHaveBeenCalled();
  });
});

describe("GET /theme/ai-providers", () => {
  it("is empty when no active app provides AI", async () => {
    const { call } = createApp();
    const response = await call("/theme/ai-providers");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { items: [] } });
  });

  it("lists each AI provider of an active app with its app, under the qualified id the draft route takes", async () => {
    const { parsePluginManifest } = await import("@scalius/shared/plugins");
    const parsed = parsePluginManifest({
      id: "acme.writer", name: "Writer", version: "1.0.0", apiVersion: "2026-10", description: "An AI app.", author: { name: "Acme" },
      providers: { ai: [{ id: "drafts", name: "Acme drafts" }] },
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    plugins.active = [{ pluginId: "acme.writer", status: "active", manifest: parsed.manifest }];
    const { call } = createApp();
    const response = await call("/theme/ai-providers");
    await expect(response.json()).resolves.toMatchObject({
      data: { items: [{ id: "acme.writer:drafts", name: "Acme drafts", appName: "Writer", appId: "acme.writer" }] },
    });
  });
});

describe("theme draft sections and restore points", () => {
  function seedDraft(sqlite: ReturnType<typeof createApp>["sqlite"]) {
    const serialized = JSON.stringify(DEFAULT_STOREFRONT_THEME);
    sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, 1, 1)").run(serialized);
    sqlite.prepare(`
      INSERT INTO theme_settings_drafts (id, theme, revision, base_published_revision, updated_by, created_at, updated_at)
      VALUES ('default', ?, 1, 1, NULL, 1, 1)
    `).run(serialized);
  }

  it("adds drafted sections to a template, then reports a stale revision as a conflict", async () => {
    const { call, sqlite } = createApp();
    seedDraft(sqlite);
    const body = { expectedDraftRevision: 1, basePublishedRevision: 1, scope: { kind: "template", template: "product", region: "after" }, sections: [faq, { type: "nope" }] };
    const response = await call("/theme/draft-sections", { method: "POST", body });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { revision: 2, basePublishedRevision: 1, added: ["faq"], rejected: 1 } });
    const stored = JSON.parse((sqlite.prepare("SELECT theme FROM theme_settings_drafts").get() as { theme: string }).theme);
    expect(stored.pages.templates.product.sections).toMatchObject([{ id: "faq", aiDraft: true }]);

    expect((await call("/theme/draft-sections", { method: "POST", body })).status).toBe(409);
    expect((await call("/theme/draft-sections", { method: "POST", body: { ...body, sections: [] } })).status).toBe(400);
  });

  it("lists a discard's restore point and puts it back in the draft", async () => {
    const { call, sqlite } = createApp();
    seedDraft(sqlite);
    const edited = storefrontTemplateTheme("boutique");
    sqlite.prepare("UPDATE theme_settings_drafts SET theme = ?, revision = 2").run(JSON.stringify(edited));
    sqlite.prepare("INSERT INTO theme_restore_points (id, theme, draft_revision, reason, created_by, created_at) VALUES ('themerp_seeded1', ?, 2, 'discard', 'user_1', 5)")
      .run(JSON.stringify(edited));

    const list = await call("/theme/restore-points");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ data: { restorePoints: [{ id: "themerp_seeded1", reason: "discard", draftRevision: 2, createdBy: "user_1" }] } });

    const body = { id: "themerp_seeded1", expectedDraftRevision: 2, basePublishedRevision: 1 };
    const restored = await call("/theme/restore-point", { method: "POST", body });
    expect(restored.status).toBe(200);
    expect((await call("/theme/restore-point", { method: "POST", body })).status).toBe(409);
    expect((await call("/theme/restore-point", { method: "POST", body: { ...body, id: "bad" } })).status).toBe(400);
    const count = sqlite.prepare("SELECT count(*) AS n FROM theme_restore_points").get();
    expect(count).toEqual({ n: 2 });
  });
});
