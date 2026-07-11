import { describe, expect, it } from "vitest";

import { storefrontCapabilityOnlySandbox } from "./capability-only-sandbox";
import { StorefrontToolCallBudgetExceededError } from "./tool-call-budget";
import {
  STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS,
  createStorefrontShoppingAssistantConfig,
} from "./agents/shopping-assistant";

const INSTANCE_ID = `v1.${"i".repeat(43)}`;
const AUTH_TOKEN = "storefront-agent-test-auth-token-at-least-32-bytes";
const THREAD_KEY = "storefront-agent-test-thread-key-at-least-32-bytes";
const COMPUTER_KEY = "storefront-agent-test-computer-key-at-least-32-bytes";

describe("Storefront shopping-assistant contract", () => {
  it("requires useful catalog navigation instead of returning a link", () => {
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "Do you sell shoes?",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "navigate only to its Scalius-returned product route",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "using exactly the successful catalog.search query",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "Do not emit tutorials",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "a link when a safe requested navigation can be completed",
    );
  });

  it("directs exact Add to Cart through the approved visible control", () => {
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "currently selected product to the cart",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "exact persisted variant",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "only when result.ok is exactly true",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "I clicked Add to Cart.",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "I could not click Add to Cart.",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "A successful browser click does not prove the cart changed",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "never click Buy Now",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "Never claim server cart",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "when result.ok is false",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "stop without retrying",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).not.toContain(
      "say only that the visible page action finished",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).not.toContain(
      "Add to Cart action completed",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).not.toContain(
      "use prepare for mutations",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).not.toContain(
      "Use status only",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).not.toContain(
      "cart, checkout, and customer-safe facts or operations",
    );
  });

  it("keeps browser observations and consequential commerce facts untrusted", () => {
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "client_command is still pending",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "Issue at most one computer command per response",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "stop that response immediately",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "Browser success is never inventory, checkout, payment, or order authority",
    );
    expect(STOREFRONT_SHOPPING_ASSISTANT_INSTRUCTIONS).toContain(
      "Never claim server cart, inventory, checkout, payment, or order state",
    );
  });

  it("exposes only application capabilities and bounds durable attempts", async () => {
    const config = createStorefrontShoppingAssistantConfig({
      id: INSTANCE_ID,
      env: {
        CANARY_AUTH_TOKEN: AUTH_TOKEN,
        THREAD_ID_SIGNING_KEY: THREAD_KEY,
        COMPUTER_TICKET_SIGNING_KEY: COMPUTER_KEY,
      },
    });
    expect(config.tools?.map((tool) => tool.name)).toEqual([
      "computer",
      "scalius",
    ]);
    expect(config.durability).toEqual({
      maxAttempts: 1,
      timeoutMs: 120_000,
    });
    expect(config.sandbox).toBe(storefrontCapabilityOnlySandbox);

    const sessionEnv = await storefrontCapabilityOnlySandbox.createSessionEnv({
      id: INSTANCE_ID,
    });
    expect(
      storefrontCapabilityOnlySandbox.tools?.(sessionEnv, { subagents: {} }),
    ).toEqual([]);
    await expect(sessionEnv.exists("AGENTS.md")).resolves.toBe(false);
    await expect(sessionEnv.readdir(".agents/skills")).resolves.toEqual([]);
    await expect(sessionEnv.exec("echo forbidden")).rejects.toThrow();

    const prohibited = new Set([
      "bash",
      "read",
      "write",
      "edit",
      "grep",
      "glob",
      "ls",
    ]);
    expect(
      config.tools?.some((tool) => prohibited.has(tool.name)),
    ).toBe(false);
  });

  it("shares a four-call budget across computer and scalius per submission", async () => {
    const config = createStorefrontShoppingAssistantConfig({
      id: INSTANCE_ID,
      env: {
        CANARY_AUTH_TOKEN: AUTH_TOKEN,
        THREAD_ID_SIGNING_KEY: THREAD_KEY,
        COMPUTER_TICKET_SIGNING_KEY: COMPUTER_KEY,
      },
    });
    const computer = config.tools?.find((tool) => tool.name === "computer");
    const scalius = config.tools?.find((tool) => tool.name === "scalius");
    expect(computer).toBeDefined();
    expect(scalius).toBeDefined();
    await computer?.run({
      input: { program: "observe" },
      signal: new AbortController().signal,
    } as never);
    await scalius?.run({
      input: { program: "help" },
      signal: new AbortController().signal,
    } as never);
    await scalius?.run({
      input: { program: "help" },
      signal: new AbortController().signal,
    } as never);
    await scalius?.run({
      input: { program: "help" },
      signal: new AbortController().signal,
    } as never);
    await expect(
      scalius?.run({
        input: { program: "help" },
        signal: new AbortController().signal,
      } as never),
    ).rejects.toBeInstanceOf(StorefrontToolCallBudgetExceededError);

    const nextConfig = createStorefrontShoppingAssistantConfig({
      id: INSTANCE_ID,
      env: {
        CANARY_AUTH_TOKEN: AUTH_TOKEN,
        THREAD_ID_SIGNING_KEY: THREAD_KEY,
        COMPUTER_TICKET_SIGNING_KEY: COMPUTER_KEY,
      },
    });
    const nextComputer = nextConfig.tools?.find(
      (tool) => tool.name === "computer",
    );
    await expect(
      nextComputer?.run({
        input: { program: "observe" },
        signal: new AbortController().signal,
      } as never),
    ).resolves.toMatchObject({ capability: "computer" });
  });

  it("admits exactly one concurrently batched browser command per submission", async () => {
    const config = createStorefrontShoppingAssistantConfig({
      id: INSTANCE_ID,
      env: {
        CANARY_AUTH_TOKEN: AUTH_TOKEN,
        THREAD_ID_SIGNING_KEY: THREAD_KEY,
        COMPUTER_TICKET_SIGNING_KEY: COMPUTER_KEY,
      },
    });
    const computer = config.tools?.find((tool) => tool.name === "computer");
    const run = (program: string) =>
      computer?.run({
        input: { program },
        signal: new AbortController().signal,
      } as never);

    const outcomes = await Promise.allSettled([run("observe"), run("observe")]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<unknown> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({
      type: "client_command",
      status: "awaiting_client_execution",
      ticket: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u),
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "A Storefront page command is already pending",
        ),
      }),
    );
  });
});
