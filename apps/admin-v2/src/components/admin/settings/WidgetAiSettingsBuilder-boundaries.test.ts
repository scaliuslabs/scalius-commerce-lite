import { describe, expect, it, vi } from "vitest";

vi.mock("~/lib/api-functions/settings", () => ({
  getWidgetAiSettings: vi.fn(),
  updateWidgetAiSettings: vi.fn(),
}));

import {
  PROFILE_DEFINITIONS,
  buildWidgetAiSettingsUpdate,
  normalizeWidgetAiSettingsData,
} from "./WidgetAiSettingsBuilder";

describe("WidgetAiSettingsBuilder model profile boundaries", () => {
  it("normalizes the compact model profiles with future assistants disabled", () => {
    const values = normalizeWidgetAiSettingsData({
      activeProvider: "openai",
      providers: {
        openai: {
          enabled: true,
          defaultModel: "gpt-5.4",
          allowedModels: ["gpt-5.4-mini"],
        },
      },
    });

    expect(PROFILE_DEFINITIONS.map((profile) => profile.id)).toEqual([
      "adminChat",
      "storefrontChat",
      "widgetGeneration",
      "imageGeneration",
      "voice",
    ]);
    expect(values.profiles.widgetGeneration).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(values.profiles.adminChat).toMatchObject({
      enabled: false,
      provider: "openai",
      model: "",
    });
    expect(values.profiles.storefrontChat.enabled).toBe(false);
    expect(values.profiles.imageGeneration.enabled).toBe(false);
    expect(values.profiles.voice.enabled).toBe(false);
  });

  it("keeps valid API profiles and falls invalid profile providers back to the active provider", () => {
    const values = normalizeWidgetAiSettingsData({
      activeProvider: "gemini",
      providers: {
        gemini: {
          enabled: true,
          defaultModel: "gemini-3-pro",
        },
        openrouter: {
          defaultModel: "anthropic/claude-sonnet-5",
        },
      },
      profiles: {
        adminChat: {
          enabled: true,
          provider: "openrouter",
          model: " anthropic/claude-sonnet-5 ",
        },
        voice: {
          enabled: true,
          provider: "not-a-provider",
          model: "",
        },
      },
    });

    expect(values.profiles.adminChat).toEqual({
      enabled: true,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5",
    });
    expect(values.profiles.voice).toEqual({
      enabled: true,
      provider: "gemini",
      model: "",
    });
  });

  it("includes profiles in the future-compatible widget AI save payload", () => {
    const values = normalizeWidgetAiSettingsData({
      activeProvider: "cloudflare",
      providers: {
        cloudflare: {
          enabled: true,
          defaultModel: "@cf/moonshotai/kimi-k2.6",
        },
      },
      profiles: {
        adminChat: {
          enabled: true,
          provider: "cloudflare",
          model: " @cf/meta/llama-4 ",
        },
      },
    });

    const payload = buildWidgetAiSettingsUpdate(values);

    expect(payload).toMatchObject({
      activeProvider: "cloudflare",
      profiles: {
        adminChat: {
          enabled: true,
          provider: "cloudflare",
          model: "@cf/meta/llama-4",
        },
        widgetGeneration: {
          enabled: true,
          provider: "cloudflare",
          model: "@cf/moonshotai/kimi-k2.6",
        },
      },
    });
  });

  it("shows and saves canonical Cloudflare catalog IDs without changing direct providers", () => {
    const values = normalizeWidgetAiSettingsData({
      activeProvider: "cloudflare",
      providers: {
        cloudflare: {
          enabled: true,
          defaultModel: "@google/nano-banana-2-lite",
          allowedModels: [
            "@openai/gpt-image-1",
            "@cf/black-forest-labs/flux-2-dev",
          ],
        },
        openai: {
          enabled: true,
          defaultModel: "@openai/gpt-image-1",
        },
      },
      profiles: {
        imageGeneration: {
          enabled: true,
          provider: "cloudflare",
          model: "@google/nano-banana-2-lite",
        },
      },
    });

    expect(values.providers.cloudflare.defaultModel).toBe(
      "google/nano-banana-2-lite",
    );
    expect(values.providers.cloudflare.allowedModels).toEqual([
      "openai/gpt-image-1",
      "@cf/black-forest-labs/flux-2-dev",
    ]);
    expect(values.profiles.imageGeneration.model).toBe(
      "google/nano-banana-2-lite",
    );
    expect(values.providers.openai.defaultModel).toBe(
      "@openai/gpt-image-1",
    );

    const payload = buildWidgetAiSettingsUpdate(values);
    expect(payload).toMatchObject({
      providers: {
        cloudflare: {
          defaultModel: "google/nano-banana-2-lite",
          allowedModels: [
            "openai/gpt-image-1",
            "@cf/black-forest-labs/flux-2-dev",
          ],
        },
        openai: {
          defaultModel: "@openai/gpt-image-1",
        },
      },
      profiles: {
        imageGeneration: {
          provider: "cloudflare",
          model: "google/nano-banana-2-lite",
        },
      },
    });
  });
});
