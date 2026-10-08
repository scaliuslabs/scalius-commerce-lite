import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

const installed = vi.hoisted(() => ({ providers: null as null | Array<Record<string, unknown>> }));

vi.mock("@scalius/core/modules/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/plugins")>()),
  getPluginInstallation: vi.fn(async (_db: unknown, pluginId: string) =>
    installed.providers && pluginId === "acme.chat" ? { pluginId, manifest: { providers: installed.providers } } : null),
}));

import { assertMessagingProviderCarries } from "./channels";

const db = {} as Database;

describe("a saved chat-channel provider", () => {
  beforeEach(() => {
    installed.providers = null;
  });

  it("is accepted when an installed app's messaging provider carries the channel", async () => {
    installed.providers = [{ kind: "messaging", id: "whatsapp", name: "Acme Chat", channels: ["whatsapp", "messenger"] }];

    await expect(assertMessagingProviderCarries(db, "acme.chat:whatsapp", "whatsapp")).resolves.toBeUndefined();
  });

  it("is refused when the app declares the provider without the channel", async () => {
    installed.providers = [{ kind: "messaging", id: "whatsapp", name: "Acme Chat", channels: ["messenger"] }];

    await expect(assertMessagingProviderCarries(db, "acme.chat:whatsapp", "whatsapp"))
      .rejects.toThrow("This app does not send on WhatsApp.");
  });

  it("is refused for an app that is not installed, or declares no such messaging provider", async () => {
    await expect(assertMessagingProviderCarries(db, "acme.chat:whatsapp", "whatsapp"))
      .rejects.toThrow("No installed app provides this messaging provider.");
    await expect(assertMessagingProviderCarries(db, "other.app:whatsapp", "whatsapp"))
      .rejects.toThrow("No installed app provides this messaging provider.");
    installed.providers = [{ kind: "sms", id: "whatsapp", name: "Acme SMS" }];
    await expect(assertMessagingProviderCarries(db, "acme.chat:whatsapp", "whatsapp"))
      .rejects.toThrow("No installed app provides this messaging provider.");
  });
});
