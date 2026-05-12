import { describe, expect, it } from "vitest";
import { normalizeMessages } from "./ai-message-normalization";

describe("AI message normalization", () => {
  it("preserves prompt cache metadata as AI SDK provider options", () => {
    const message = normalizeMessages([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "static store context",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
          { type: "text", text: "dynamic request" },
        ],
      },
    ])[0]!;

    const content = message.content as Array<{
      type: string;
      providerOptions?: Record<string, Record<string, unknown>>;
    }>;

    expect(content[0]?.providerOptions).toEqual({
      openrouter: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
    expect(content[1]?.providerOptions).toBeUndefined();
  });

  it("merges existing provider options with prompt cache metadata", () => {
    const message = normalizeMessages([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "static store context",
            cache_control: { type: "ephemeral" },
            providerOptions: {
              openrouter: { transforms: ["middle-out"] },
            },
          },
        ],
      },
    ])[0]!;

    const content = message.content as Array<{
      providerOptions?: Record<string, Record<string, unknown>>;
    }>;

    expect(content[0]?.providerOptions).toEqual({
      openrouter: {
        transforms: ["middle-out"],
        cacheControl: { type: "ephemeral" },
      },
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("ignores invalid prompt cache metadata", () => {
    const message = normalizeMessages([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "static store context",
            cache_control: { type: "forever" },
          },
        ],
      },
    ])[0]!;

    const content = message.content as Array<{ providerOptions?: unknown }>;
    expect(content[0]?.providerOptions).toBeUndefined();
  });
});
