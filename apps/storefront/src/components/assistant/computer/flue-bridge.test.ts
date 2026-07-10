// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { issueScaliusComputerCommand } from "@scalius/shared/assistant-computer-handoff";

import {
  STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
  StorefrontFlueComputerCoordinator,
  parseStorefrontFlueComputerClientCommand,
  postStorefrontFlueComputerResult,
  type StorefrontFlueDynamicToolPart,
} from "./flue-bridge";
import { createStorefrontAssistantComputerRuntime } from "./runtime";
import type { StorefrontNavigationAuthority } from "../storefront-navigation-authority";

const NOW = 1_800_000_000_000;
const SIGNING_KEY = "storefront-flue-ui-bridge-test-key-at-least-32-bytes";
const INSTANCE_ID = `v1.${"a".repeat(43)}`;
const THREAD_ID = "conv_abcdefghijklmnopqrstuv";
const TAB_ID = "tab_abcdefghijklmnopqrstuv";

function toolPart(
  output: unknown,
  input: unknown = { program: "observe" },
): StorefrontFlueDynamicToolPart {
  return {
    type: "dynamic-tool",
    toolName: "computer",
    toolCallId: "tool-call-1",
    state: "output-available",
    input,
    output,
  };
}

async function command(program: string, fill = 1) {
  return issueScaliusComputerCommand({
    surface: "storefront",
    agentName: "shopping-assistant",
    instanceId: INSTANCE_ID,
    program,
    signingKey: SIGNING_KEY,
    now: NOW,
    ttlMs: 120_000,
    randomBytes: new Uint8Array(16).fill(fill),
  });
}

function source(
  issued: Awaited<ReturnType<typeof command>>,
  overrides: Partial<{
    threadId: string;
    tabId: string;
    input: unknown;
    output: unknown;
    navigationAuthority: StorefrontNavigationAuthority;
  }> = {},
) {
  return {
    threadId: overrides.threadId ?? THREAD_ID,
    tabId: overrides.tabId ?? TAB_ID,
    navigationAuthority: overrides.navigationAuthority,
    part: toolPart(
      overrides.output ?? issued,
      overrides.input ?? { program: issued.program },
    ),
  };
}

describe("Storefront Flue computer coordinator", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/products");
    window.sessionStorage.removeItem(
      STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
    );
  });

  it("does not report completion until the exact continuation is accepted", async () => {
    document.body.innerHTML =
      '<main><button data-scalius-computer-action="allow">Open filters</button></main>';
    const clicked = vi.fn();
    document.querySelector("button")?.addEventListener("click", clicked);
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const handle = observed.output.match(
      /(@r\d+\.e\d+) button "Open filters"/u,
    )?.[1];
    expect(handle).toBeTruthy();

    let admit:
      | ((value: { accepted: true; requestId: string }) => void)
      | undefined;
    const postResult = vi.fn(
      () =>
        new Promise<{ accepted: true; requestId: string }>((resolve) => {
          admit = resolve;
        }),
    );
    const phases: string[] = [];
    const coordinator = new StorefrontFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
      onPhase: (_requestId, phase) => phases.push(phase),
    });
    const issued = await command(`click ${handle}`, 2);
    const outcomePromise = coordinator.consume(source(issued));

    await vi.waitFor(() => expect(postResult).toHaveBeenCalledOnce());
    expect(clicked).toHaveBeenCalledOnce();
    expect(phases).toEqual(["executing", "posting_untrusted_result"]);
    let settled = false;
    void outcomePromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    admit?.({ accepted: true, requestId: issued.requestId });
    await expect(outcomePromise).resolves.toMatchObject({
      status: "continuation_accepted",
      requestId: issued.requestId,
      authoritative: false,
    });
    expect(phases.at(-1)).toBe("continuation_accepted");
  });

  it("claims before awaiting and deduplicates concurrent, replayed, and refreshed commands", async () => {
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const execute = vi.spyOn(runtime, "execute");
    let admit:
      | ((value: { accepted: true; requestId: string }) => void)
      | undefined;
    const postResult = vi.fn(
      () =>
        new Promise<{ accepted: true; requestId: string }>((resolve) => {
          admit = resolve;
        }),
    );
    const issued = await command("observe", 3);
    const coordinator = new StorefrontFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
    });
    const first = coordinator.consume(source(issued));
    await expect(coordinator.consume(source(issued))).resolves.toMatchObject({
      status: "duplicate",
      requestId: issued.requestId,
    });
    expect(execute).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(postResult).toHaveBeenCalledOnce());
    admit?.({ accepted: true, requestId: issued.requestId });
    await first;

    const persisted = window.sessionStorage.getItem(
      STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
    );
    expect(persisted).toContain(issued.requestId);
    expect(persisted).toContain(THREAD_ID);
    expect(persisted).toContain(TAB_ID);
    expect(persisted).not.toContain(issued.program);
    expect(persisted).not.toContain(issued.ticket);
    expect(persisted).not.toContain("PAGE");

    const remountedRuntime = createStorefrontAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const remountedExecute = vi.spyOn(remountedRuntime, "execute");
    const remounted = new StorefrontFlueComputerCoordinator({
      runtime: remountedRuntime,
      now: () => NOW + 2_000,
    });
    await expect(remounted.consume(source(issued))).resolves.toMatchObject({
      status: "duplicate",
      phase: "continuation_accepted",
    });
    expect(remountedExecute).not.toHaveBeenCalled();
  });

  it("rejects expiry, cross-thread, cross-tab, cross-surface, and input mismatches", async () => {
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const execute = vi.spyOn(runtime, "execute");
    const issued = await command("observe", 4);
    const expired = new StorefrontFlueComputerCoordinator({
      runtime,
      now: () => NOW + 120_001,
    });

    await expect(expired.consume(source(issued))).resolves.toEqual({
      status: "rejected",
      reason: "expired_client_command",
    });
    const active = new StorefrontFlueComputerCoordinator({
      runtime,
      now: () => NOW + 1_000,
    });
    await expect(
      active.consume(
        source(issued, {
          threadId: "conv_zyxwvutsrqponmlkjihgfe",
        }),
      ),
    ).resolves.toEqual({
      status: "rejected",
      reason: "binding_mismatch",
    });
    await expect(
      active.consume(
        source(issued, {
          tabId: "tab_zyxwvutsrqponmlkjihgfe",
        }),
      ),
    ).resolves.toEqual({
      status: "rejected",
      reason: "binding_mismatch",
    });
    await expect(
      active.consume(
        source(issued, {
          output: { ...issued, surface: "admin" },
        }),
      ),
    ).resolves.toEqual({
      status: "rejected",
      reason: "invalid_client_command",
    });
    await expect(
      active.consume(
        source(issued, {
          input: { program: "refresh" },
        }),
      ),
    ).resolves.toEqual({
      status: "rejected",
      reason: "invalid_client_command",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a signed goto unless latest explicit intent and route provenance agree", async () => {
    const navigate = vi.fn();
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
      navigate,
    });
    const execute = vi.spyOn(runtime, "execute");
    const postResult = vi.fn(async (payload) => ({
      accepted: true as const,
      requestId: payload.requestId,
    }));
    const coordinator = new StorefrontFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
    });
    const issued = await command("goto /products/everyday-shoes", 12);

    await expect(coordinator.consume(source(issued))).resolves.toMatchObject({
      status: "continuation_accepted",
      result: { ok: false, code: "ROUTE_BLOCKED", retryable: false },
    });
    expect(postResult).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();

    const otherIssued = await command("goto /products/everyday-shoes", 13);
    await expect(
      coordinator.consume(
        source(otherIssued, {
          navigationAuthority: {
            latestUserText: "What is the price?",
            candidates: [
              {
                route: "/products/everyday-shoes",
                label: "Everyday Shoes",
                source: "scalius",
              },
            ],
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "continuation_accepted",
      result: { ok: false, code: "ROUTE_BLOCKED", retryable: false },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("binds a visible link click to exact latest intent and route provenance", async () => {
    document.body.innerHTML = `
      <main>
        <a href="/products/everyday-shoes">Everyday Shoes</a>
        <a href="/products/other-shoes">Other Shoes</a>
      </main>`;
    const clicked = vi.fn((event: Event) => event.preventDefault());
    for (const link of document.querySelectorAll("a")) {
      link.addEventListener("click", clicked);
    }
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const coordinator = new StorefrontFlueComputerCoordinator({
      runtime,
      postResult: async (payload) => ({
        accepted: true,
        requestId: payload.requestId,
      }),
      now: () => NOW + 1_000,
    });
    const observed = await coordinator.consume(
      source(await command("observe", 14)),
    );
    if (observed.status !== "continuation_accepted") {
      throw new Error("observe failed");
    }
    const handle = observed.result.output.match(
      /(@r\d+\.e\d+) link "Everyday Shoes"/u,
    )?.[1];
    expect(handle).toBeTruthy();

    const unrelated = await coordinator.consume(
      source(await command(`click ${handle}`, 15), {
        navigationAuthority: {
          latestUserText: "What is its price?",
          candidates: [
            {
              route: "/products/everyday-shoes",
              label: "Everyday Shoes",
              source: "visible-page",
            },
          ],
        },
      }),
    );
    expect(unrelated).toMatchObject({
      status: "continuation_accepted",
      result: { ok: false, code: "ROUTE_BLOCKED" },
    });
    expect(clicked).not.toHaveBeenCalled();

    const exact = await coordinator.consume(
      source(await command(`click ${handle}`, 16), {
        navigationAuthority: {
          latestUserText: "Take me to Everyday Shoes",
          candidates: [
            {
              route: "/products/everyday-shoes",
              label: "Everyday Shoes",
              source: "visible-page",
            },
          ],
        },
      }),
    );
    expect(exact).toMatchObject({
      status: "continuation_accepted",
      result: { ok: true, code: "EXECUTED" },
    });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("fails closed before page work when refresh-safe dedupe storage is unavailable", async () => {
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const execute = vi.spyOn(runtime, "execute");
    const coordinator = new StorefrontFlueComputerCoordinator({
      runtime,
      dedupeStorage: null,
      now: () => NOW + 1_000,
    });

    await expect(
      coordinator.consume(source(await command("observe", 5))),
    ).resolves.toEqual({
      status: "rejected",
      reason: "dedupe_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("posts a private-page HUMAN_REQUIRED result without observing protected DOM", async () => {
    window.history.replaceState({}, "", "/checkout");
    document.body.innerHTML =
      '<main><input name="phone" value="01700000000"><button>Pay now</button></main>';
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const postResult = vi.fn(async (payload) => ({
      accepted: true as const,
      requestId: payload.requestId,
    }));
    const coordinator = new StorefrontFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
    });

    const outcome = await coordinator.consume(
      source(await command("observe", 6)),
    );
    expect(outcome).toMatchObject({
      status: "continuation_accepted",
      result: {
        ok: false,
        code: "HUMAN_REQUIRED",
      },
    });
    expect(postResult).toHaveBeenCalledOnce();
    expect(JSON.stringify(postResult.mock.calls[0]?.[0])).not.toContain(
      "01700000000",
    );
  });

  it("preserves stale revision failures as untrusted continuation results", async () => {
    document.body.innerHTML =
      '<main><button data-scalius-computer-action="allow">Details</button></main>';
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const postResult = vi.fn(async (payload) => ({
      accepted: true as const,
      requestId: payload.requestId,
    }));
    const coordinator = new StorefrontFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
    });
    const observed = await coordinator.consume(
      source(await command("observe", 7)),
    );
    if (observed.status !== "continuation_accepted") {
      throw new Error("observe failed");
    }
    const handle = observed.result.output.match(
      /(@r\d+\.e\d+) button "Details"/u,
    )?.[1];
    expect(handle).toBeTruthy();

    document
      .querySelector("main")
      ?.insertAdjacentHTML("afterbegin", "<h1>Changed</h1>");
    const stale = await coordinator.consume(
      source(await command(`click ${handle}`, 8)),
    );
    expect(stale).toMatchObject({
      status: "continuation_accepted",
      result: { ok: false, code: "STALE_CONTEXT" },
    });
  });

  it("keeps an uncertain post terminal and never presents it as accepted", async () => {
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const postResult = vi.fn(async () => {
      throw new Error("network response lost");
    });
    const coordinator = new StorefrontFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
    });
    const issued = await command("observe", 9);

    await expect(coordinator.consume(source(issued))).resolves.toMatchObject({
      status: "continuation_failed",
      requestId: issued.requestId,
    });
    await expect(coordinator.consume(source(issued))).resolves.toMatchObject({
      status: "duplicate",
      phase: "continuation_failed",
    });
    expect(postResult).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight continuation and never posts completion after Stop", async () => {
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    let postSignal: AbortSignal | undefined;
    const postResult = vi.fn(
      (_payload, options?: { signal?: AbortSignal }) =>
        new Promise<{ accepted: true; requestId: string }>((_resolve, reject) => {
          postSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const phases: string[] = [];
    const postCancellation = vi.fn(async (payload) => ({
      accepted: true as const,
      requestId: payload.requestId,
    }));
    const coordinator = new StorefrontFlueComputerCoordinator({
      runtime,
      postResult,
      postCancellation,
      now: () => NOW + 1_000,
      onPhase: (_requestId, phase) => phases.push(phase),
    });
    const issued = await command("observe", 17);
    const consuming = coordinator.consume(source(issued));
    await vi.waitFor(() => expect(postResult).toHaveBeenCalledOnce());

    coordinator.cancelPending();

    expect(postSignal?.aborted).toBe(true);
    expect(postCancellation).toHaveBeenCalledOnce();
    expect(postCancellation).toHaveBeenCalledWith({
      surface: "storefront",
      threadId: THREAD_ID,
      requestId: issued.requestId,
      ticket: issued.ticket,
      program: issued.program,
    });
    await expect(consuming).resolves.toEqual({
      status: "cancelled",
      requestId: issued.requestId,
    });
    expect(phases.at(-1)).toBe("cancelled");
    await expect(coordinator.consume(source(issued))).resolves.toMatchObject({
      status: "duplicate",
      phase: "cancelled",
    });
  });
});

describe("Storefront Flue command parsing and same-origin result POST", () => {
  beforeEach(() => {
    window.sessionStorage.removeItem(
      STOREFRONT_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
    );
  });

  it("accepts only the exact beta.9 client_command output contract", async () => {
    const issued = await command("observe", 10);
    expect(
      parseStorefrontFlueComputerClientCommand(issued, NOW + 1_000),
    ).toEqual({ ok: true, command: issued });
    expect(
      parseStorefrontFlueComputerClientCommand(
        { ...issued, success: true },
        NOW + 1_000,
      ),
    ).toEqual({ ok: false, reason: "invalid_client_command" });
  });

  it("posts only a bounded conversation-scoped cookie request and requires exact 202", async () => {
    const issued = await command("observe", 11);
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          `/api/assistant/conversations/${THREAD_ID}/computer/results`,
        );
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("same-origin");
        expect(init?.keepalive).toBe(true);
        expect(
          [...new Headers(init?.headers).entries()].map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        ).toEqual([["content-type", "application/json"]]);
        await expect(new Response(init?.body).json()).resolves.toMatchObject({
          surface: "storefront",
          threadId: THREAD_ID,
          requestId: issued.requestId,
        });
        return Response.json(
          {
            accepted: true,
            authoritative: false,
            status: "queued_for_agent_interpretation",
            requestId: issued.requestId,
          },
          { status: 202 },
        );
      },
    );
    const payload = {
      surface: "storefront" as const,
      threadId: THREAD_ID,
      requestId: issued.requestId,
      ticket: issued.ticket,
      program: issued.program,
      result: {
        ok: true as const,
        code: "OBSERVED" as const,
        output: "PAGE rev=r1",
        revision: "r1",
        changed: false,
      },
    };

    await expect(
      postStorefrontFlueComputerResult(payload, fetcher),
    ).resolves.toEqual({
      accepted: true,
      requestId: issued.requestId,
    });
    await expect(
      postStorefrontFlueComputerResult(
        payload,
        vi.fn(async () =>
          Response.json(
            {
              accepted: true,
              authoritative: false,
              status: "queued_for_agent_interpretation",
              requestId: issued.requestId,
            },
            { status: 200 },
          ),
        ),
      ),
    ).rejects.toThrow("not accepted");
  });
});
