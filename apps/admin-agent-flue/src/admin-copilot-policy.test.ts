import { parseScaliusComputerProgram } from "@scalius/shared/assistant-computer";
import { parseScaliusCommandProgram } from "@scalius/shared/assistant-command";
import { describe, expect, it } from "vitest";
import adminCopilot, { description } from "./agents/admin-copilot";
import {
  ADMIN_ENTRY_PAGES,
  buildAdminCopilotInstructions,
  isKnownAdminEntryRoute,
} from "./admin-copilot-policy";
import {
  ADMIN_AGENT_CAPABILITY_CALL_LIMIT,
  ADMIN_AGENT_DURABILITY,
  ADMIN_CAPABILITY_ONLY_SANDBOX,
  createAdminCapabilityCallBudget,
} from "./capability-runtime";

const EXPECTED_ENTRY_ROUTES = [
  "/admin",
  "/admin/products",
  "/admin/products/new",
  "/admin/categories",
  "/admin/categories/new",
  "/admin/attributes",
  "/admin/collections",
  "/admin/collections/new",
  "/admin/inventory",
  "/admin/pages",
  "/admin/widgets",
  "/admin/media",
  "/admin/orders",
  "/admin/orders/new",
  "/admin/abandoned-checkouts",
  "/admin/customers",
  "/admin/customers/new",
  "/admin/discounts",
  "/admin/discounts/new",
  "/admin/analytics",
  "/admin/settings",
  "/admin/settings/theme",
  "/admin/settings/account",
  "/admin/settings/notifications",
  "/admin/settings/hero-sliders",
  "/admin/settings/checkout",
  "/admin/settings/taxes",
  "/admin/settings/delivery-providers",
  "/admin/settings/fraud-checker",
  "/admin/settings/meta-conversion",
  "/admin/settings/cache",
];

describe("Admin copilot runtime policy", () => {
  it("keeps one exact, query-free route for every dashboard navigation entry", () => {
    expect(ADMIN_ENTRY_PAGES.map(({ route }) => route)).toEqual(EXPECTED_ENTRY_ROUTES);
    expect(new Set(EXPECTED_ENTRY_ROUTES).size).toBe(EXPECTED_ENTRY_ROUTES.length);
    for (const route of EXPECTED_ENTRY_ROUTES) {
      expect(isKnownAdminEntryRoute(route)).toBe(true);
      expect(parseScaliusComputerProgram(`goto ${route}`)).toMatchObject({ ok: true });
      expect(route).not.toMatch(/[?#]/u);
    }
    expect(isKnownAdminEntryRoute("/admin/products/new")).toBe(true);
    expect(isKnownAdminEntryRoute("/admin/products/prod_private/edit")).toBe(false);
    expect(isKnownAdminEntryRoute("/admin/products?status=active")).toBe(false);
  });

  it("gives realistic navigation, page-context, fact, continuation, and mutation rules", () => {
    const instructions = buildAdminCopilotInstructions();
    expect(instructions).toContain(
      "`Take me to Products page` => immediately call computer with `goto /admin/products`",
    );
    expect(instructions).toContain(
      "`Create a test product with real images` => immediately call computer with `goto /admin/products/new`",
    );
    expect(instructions).toContain(
      "`Can you open Taxes?` => immediately call computer with `goto /admin/settings/taxes`",
    );
    expect(instructions).toContain(
      "`How many products do we have?` => immediately call scalius with `call admin.api.get.products.stats -- {}`",
    );
    expect(instructions).toContain("`What am I looking at?` => call computer with `observe`");
    expect(instructions).toContain("call no more tools in that operation");
    expect(instructions).toContain("reply only with a short completion");
    expect(instructions).toContain("Never answer a total from the number of visible table rows");
    expect(instructions).toContain("Never confirm, approve, or execute a prepared mutation yourself");
    expect(instructions).toContain("Never expose or quote internal tool names");
    expect(instructions).toContain("Never use shell, filesystem, local image generation");
    expect(parseScaliusCommandProgram("call admin.api.get.products.stats -- {}"))
      .toMatchObject({
        ok: true,
        command: {
          name: "call",
          capabilityId: "admin.api.get.products.stats",
        },
      });
  });

  it("initializes only the bounded computer and authoritative Scalius tools", async () => {
    const config = await adminCopilot.initialize({
      id: `v1.${"a".repeat(43)}`,
      env: {
        CANARY_AUTH_TOKEN: "a".repeat(32),
        THREAD_ID_SIGNING_KEY: "b".repeat(32),
        COMPUTER_TICKET_SIGNING_KEY: "c".repeat(32),
      },
    });

    expect(description).toBe("Operates the authenticated Scalius Admin dashboard.");
    expect(config.model).toBe("cloudflare/@cf/moonshotai/kimi-k2.6");
    expect(config.thinkingLevel).toBe("medium");
    expect(config.durability).toEqual(ADMIN_AGENT_DURABILITY);
    expect(config.sandbox).toBe(ADMIN_CAPABILITY_ONLY_SANDBOX);
    expect(config.tools?.map(({ name }) => name)).toEqual(["computer", "scalius"]);
    expect(config.instructions).toBe(buildAdminCopilotInstructions());
  });

  it("removes Flue's default shell/filesystem tools and bounds capability calls", async () => {
    const env = await ADMIN_CAPABILITY_ONLY_SANDBOX.createSessionEnv({ id: "thread" });
    expect(ADMIN_CAPABILITY_ONLY_SANDBOX.tools?.(env, { subagents: {} })).toEqual([]);
    expect(await env.exists("/anything")).toBe(false);
    await expect(env.exec("echo nope")).rejects.toThrow("workspace is unavailable");

    const consume = createAdminCapabilityCallBudget();
    for (let index = 0; index < ADMIN_AGENT_CAPABILITY_CALL_LIMIT; index += 1) consume();
    expect(consume).toThrow("capability call limit");
  });
});
