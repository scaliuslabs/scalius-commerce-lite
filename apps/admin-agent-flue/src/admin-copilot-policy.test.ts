import { parseScaliusComputerProgram } from "@scalius/shared/assistant-computer";
import { parseScaliusCommandProgram } from "@scalius/shared/assistant-command";
import { describe, expect, it } from "vitest";
import adminCopilot, { description } from "./agents/admin-copilot";
import {
  ADMIN_ENTRY_PAGES,
  buildAdminCopilotInstructions,
  isKnownAdminEntryRoute,
} from "./admin-copilot-policy";

const EXPECTED_ENTRY_ROUTES = [
  "/admin",
  "/admin/products",
  "/admin/categories",
  "/admin/attributes",
  "/admin/collections",
  "/admin/inventory",
  "/admin/pages",
  "/admin/widgets",
  "/admin/media",
  "/admin/orders",
  "/admin/abandoned-checkouts",
  "/admin/customers",
  "/admin/discounts",
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
    expect(isKnownAdminEntryRoute("/admin/products/new")).toBe(false);
    expect(isKnownAdminEntryRoute("/admin/products?status=active")).toBe(false);
  });

  it("gives realistic navigation, page-context, fact, continuation, and mutation rules", () => {
    const instructions = buildAdminCopilotInstructions();
    expect(instructions).toContain(
      "`Take me to Products page` => immediately call computer with `goto /admin/products`",
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
    expect(config.tools?.map(({ name }) => name)).toEqual(["computer", "scalius"]);
    expect(config.instructions).toBe(buildAdminCopilotInstructions());
  });
});
