import { describe, expect, it, vi } from "vitest";
import type { PluginInstallation } from "@scalius/core/modules/plugins";

const stored = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("@scalius/core/modules/plugins", () => ({
  readPluginRuntimeSettings: async () => ({ values: stored.values, unreadableSecrets: [] }),
}));

import { readAppProviderSettings, type AppProviderRuntime } from "./runtime";

const installation = {
  pluginId: "acme.pay",
  status: "active",
  source: "bundled",
  grant: { providers: ["payment"] },
  manifest: {
    name: "Acme Pay",
    settings: [
      { key: "merchant_id", label: "Merchant ID", type: "text", required: true },
      { key: "merchant_private_key", label: "Merchant private key", type: "secret", required: true },
    ],
  },
} as unknown as PluginInstallation;
const runtime = { canRun: () => true } as unknown as AppProviderRuntime;

describe("what a provider asks the merchant to fill in", () => {
  it("names a missing setting by its label, never by its field name", async () => {
    stored.values = {};
    const settings = await readAppProviderSettings(runtime, installation, { kind: "payment", settings: undefined } as never, undefined);
    expect(settings.missingFields).toEqual(["merchant_id", "merchant_private_key"]);
    expect(settings.blockedReason).toBe("Complete Acme Pay's settings: Merchant ID, Merchant private key.");
    expect(settings.blockedReason).not.toContain("merchant_private_key");
  });
});
