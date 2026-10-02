// Every bundled (first-party) app's every dashboard surface (its pages, its
// resource cards and its home widgets) answers a UI document the dashboard
// draws: checked with the dashboard's own parser (the real UI schema), and
// every button and form posts only to an admin route the app declares (the
// dashboard refuses anything else). Run before any event and after one of
// each declared event, so both the empty and the filled answers are covered.
import { describe, expect, it } from "vitest";
import {
  createPluginTestHarness,
  parsePluginUiDocument,
  pluginUiRouteActions,
} from "@scalius/plugin-sdk/testing";
import type { PluginApiCallInput } from "@scalius/plugin-sdk";
import type { PluginManifest } from "@scalius/shared/plugins";
import { BUNDLED_PLUGINS } from "./bundled.gen";

/** A store that answers every read the apps make, as a paid order. */
const api = async (_operationId: string, input: PluginApiCallInput | undefined) => ({
  ok: true as const,
  status: 200,
  data: { id: String(input?.path?.id ?? "ord_1"), status: "paid", paymentStatus: "paid", totalAmount: 1500, items: [] },
  error: null,
});

const RESOURCE_IDS: Record<string, string> = { order: "ord_1", product: "prod_1", customer: "cust_1" };

function surfaces(manifest: PluginManifest) {
  return [
    ...manifest.admin.pages.map((page) => ({ label: `page ${page.id}`, route: page.route, query: {} as Record<string, string> })),
    ...manifest.admin.cards.map((card) => ({
      label: `${card.target} card ${card.id}`,
      route: card.route,
      query: { resource: card.target, id: RESOURCE_IDS[card.target] ?? `${card.target}_1`, surface: card.id },
    })),
    ...manifest.admin.widgets.map((widget) => ({ label: `widget ${widget.id}`, route: widget.route, query: { surface: widget.id } })),
  ];
}

describe.each(Object.keys(BUNDLED_PLUGINS))("bundled app %s", (pluginId) => {
  it("answers every dashboard surface with a document the dashboard draws", async () => {
    const module = ((await BUNDLED_PLUGINS[pluginId]!.load()) as { default: unknown }).default;
    const harness = createPluginTestHarness(module, { api });
    const manifest = harness.manifest;
    const declared = new Map(manifest.routes.admin.map((route) => [route.name, route.methods as readonly string[]]));

    const check = async (phase: string) => {
      for (const surface of surfaces(manifest)) {
        const outcome = await harness.route("admin", surface.route, { query: surface.query });
        const where = `${pluginId} ${surface.label} (${phase})`;
        expect(outcome.ok, `${where}: ${outcome.error?.message ?? ""}`).toBe(true);
        const parsed = parsePluginUiDocument((outcome.value as { body?: unknown } | null)?.body);
        expect(parsed, where).toMatchObject({ ok: true });
        if (!parsed.ok) continue;
        for (const action of pluginUiRouteActions(parsed.document.root)) {
          expect(declared.get(action.route), `${where}: posts to undeclared route ${action.route}`)
            .toContain(action.method ?? "POST");
        }
        const pages = new Set(manifest.admin.pages.map((page) => page.id));
        for (const match of JSON.stringify(parsed.document).matchAll(/"kind":"app-page","page":"([^"]+)"/g)) {
          expect(pages.has(match[1]!), `${where}: links to undeclared page ${match[1]}`).toBe(true);
        }
      }
    };

    await check("before any event");
    // Each concrete topic it listens to once (a wildcard subscription names none).
    for (const topic of manifest.events.filter((filter) => !filter.includes("*"))) {
      const [resource] = topic.split(".");
      await harness.event(topic as Parameters<typeof harness.event>[0], { type: resource!, id: RESOURCE_IDS[resource!] ?? `${resource}_1` });
    }
    await check("after its events");
  });
});
