// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { issueScaliusComputerCommand } from "@scalius/shared/assistant-computer-handoff";

import {
  ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
  AdminFlueComputerCoordinator,
  cancelAdminFlueComputerHandoff,
  parseAdminFlueComputerClientCommand,
  postAdminFlueComputerResult,
  type AdminFlueDynamicToolPart,
} from "./flue-bridge";
import { createAdminAssistantComputerRuntime } from "./runtime";

const NOW = 1_800_000_000_000;
const SIGNING_KEY = "admin-flue-ui-bridge-test-key-at-least-32-bytes";
const INSTANCE_ID = `v1.${"a".repeat(43)}`;
const THREAD_ID = "admin-thread-1";
const TAB_ID = "admin-tab-1";

function toolPart(output: unknown): AdminFlueDynamicToolPart {
  return {
    type: "dynamic-tool",
    toolName: "computer",
    toolCallId: "tool-call-1",
    state: "output-available",
    input: { program: "observe" },
    output,
  };
}

async function command(program: string, fill = 1) {
  return issueScaliusComputerCommand({
    surface: "admin",
    agentName: "admin-copilot",
    instanceId: INSTANCE_ID,
    program,
    signingKey: SIGNING_KEY,
    now: NOW,
    ttlMs: 120_000,
    randomBytes: new Uint8Array(16).fill(fill),
  });
}

function source(
  output: unknown,
  overrides: Partial<{
    threadId: string;
    tabId: string;
    latestUserMessage: string;
  }> = {},
) {
  return {
    threadId: overrides.threadId ?? THREAD_ID,
    tabId: overrides.tabId ?? TAB_ID,
    latestUserMessage: overrides.latestUserMessage,
    part: toolPart(output),
  };
}

describe("Admin Flue computer coordinator", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/admin/products");
    window.sessionStorage.removeItem(ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY);
  });

  it("keeps the command pending until the exact untrusted continuation is accepted", async () => {
    document.body.innerHTML = '<main><button data-scalius-computer-action="allow">Open filters</button></main>';
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    const runtime = createAdminAssistantComputerRuntime({ threadId: THREAD_ID, tabId: TAB_ID });
    const observed = await runtime.execute({ binding: runtime.binding, program: "observe" });
    const handle = observed.output.match(/(@r\d+\.e\d+) button "Open filters"/u)?.[1];
    expect(handle).toBeTruthy();

    let admit: ((value: { accepted: true; requestId: string }) => void) | undefined;
    const postResult = vi.fn(() => new Promise<{ accepted: true; requestId: string }>((resolve) => {
      admit = resolve;
    }));
    const phases: string[] = [];
    const coordinator = new AdminFlueComputerCoordinator({
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
    void outcomePromise.then(() => { settled = true; });
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

  it("claims a request before awaiting and never executes or posts a replay twice", async () => {
    const runtime = createAdminAssistantComputerRuntime({ threadId: THREAD_ID, tabId: TAB_ID });
    const execute = vi.spyOn(runtime, "execute");
    let admit: ((value: { accepted: true; requestId: string }) => void) | undefined;
    const postResult = vi.fn(() => new Promise<{ accepted: true; requestId: string }>((resolve) => {
      admit = resolve;
    }));
    const coordinator = new AdminFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
    });
    const issued = await command("observe", 3);
    const first = coordinator.consume(source(issued));
    const duplicate = await coordinator.consume(source(issued));

    expect(duplicate).toMatchObject({ status: "duplicate", requestId: issued.requestId });
    expect(execute).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(postResult).toHaveBeenCalledOnce());
    admit?.({ accepted: true, requestId: issued.requestId });
    await first;
    await expect(coordinator.consume(source(issued))).resolves.toMatchObject({
      status: "duplicate",
      phase: "continuation_accepted",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(postResult).toHaveBeenCalledOnce();
  });

  it("resumes the exact signed continuation only after the real app action completes", async () => {
    document.body.innerHTML = `
      <main>
        <button
          data-scalius-computer-human-only
          data-scalius-computer-human-confirmation="admin.media.image.generate.library-page.panel-a"
        >Generate image</button>
      </main>`;
    const runtime = createAdminAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const handle = observed.output.match(
      /(@r\d+\.e\d+) button "Generate image"/u,
    )?.[1];
    expect(handle).toBeTruthy();
    const postResult = vi.fn(async (payload: Parameters<typeof postAdminFlueComputerResult>[0]) => ({
      accepted: true as const,
      requestId: payload.requestId,
    }));
    const phases: string[] = [];
    const coordinator = new AdminFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
      onPhase: (_requestId, phase) => phases.push(phase),
    });
    const issued = await command(`click ${handle}`, 15);

    await expect(coordinator.consume(source(issued))).resolves.toEqual({
      status: "awaiting_human_confirmation",
      requestId: issued.requestId,
      actionId: "admin.media.image.generate.library-page.panel-a",
    });
    expect(postResult).not.toHaveBeenCalled();
    expect(coordinator.pendingHumanConfirmationCount()).toBe(1);
    expect(phases).toEqual(["executing", "awaiting_human_confirmation"]);
    const operationId = `aho_${"a".repeat(24)}`;

    const otherThread = new AdminFlueComputerCoordinator({
      runtime: createAdminAssistantComputerRuntime({
        threadId: "admin-thread-2",
        tabId: TAB_ID,
      }),
      postResult,
      now: () => NOW + 1_000,
    });
    await expect(otherThread.confirmHumanAction({
      actionId: "admin.media.image.generate.library-page",
      operationId,
      outcome: "succeeded",
    })).resolves.toEqual({
      status: "ignored",
      reason: "no_pending_confirmation",
    });
    expect(coordinator.pendingHumanConfirmationCount()).toBe(1);

    await expect(coordinator.confirmHumanAction({
      actionId: "admin.media.image.save.library-page.panel-a",
      operationId,
      outcome: "succeeded",
    })).resolves.toEqual({
      status: "ignored",
      reason: "no_pending_confirmation",
    });
    expect(postResult).not.toHaveBeenCalled();

    expect(coordinator.registerHumanActionStart({
      actionId: "admin.media.image.generate.library-page.panel-a",
      operationId,
    })).toBe(true);
    await expect(coordinator.confirmHumanAction({
      actionId: "admin.media.image.generate.library-page.panel-a",
      operationId,
      outcome: "succeeded",
    })).resolves.toMatchObject({
      status: "continuation_accepted",
      requestId: issued.requestId,
      authoritative: false,
      result: { ok: true, code: "EXECUTED", changed: true },
    });
    expect(postResult).toHaveBeenCalledOnce();
    expect(postResult).toHaveBeenCalledWith(expect.objectContaining({
      surface: "admin",
      threadId: THREAD_ID,
      requestId: issued.requestId,
      ticket: issued.ticket,
      program: issued.program,
      result: expect.objectContaining({
        ok: true,
        code: "EXECUTED",
        output: expect.stringContaining("untrusted"),
      }),
    }));
    expect(coordinator.pendingHumanConfirmationCount()).toBe(0);
    await expect(coordinator.confirmHumanAction({
      actionId: "admin.media.image.generate.library-page.panel-a",
      operationId,
      outcome: "succeeded",
    })).resolves.toEqual({
      status: "ignored",
      reason: "no_pending_confirmation",
    });
    expect(postResult).toHaveBeenCalledOnce();
  });

  it("reconstructs a reload from opaque markers and resumes the exact replayed submission", async () => {
    document.body.innerHTML = `
      <main>
        <button
          data-scalius-computer-human-only
          data-scalius-computer-human-confirmation="admin.media.image.save.media-picker.panel-b"
        >Save generated image</button>
      </main>`;
    const runtime = createAdminAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const handle = observed.output.match(
      /(@r\d+\.e\d+) button "Save generated image"/u,
    )?.[1];
    const clock = NOW + 1_000;
    const postResult = vi.fn(async (payload: Parameters<typeof postAdminFlueComputerResult>[0]) => ({
      accepted: true as const,
      requestId: payload.requestId,
    }));
    const coordinator = new AdminFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => clock,
    });
    const issued = await command(`click ${handle}`, 16);

    await expect(coordinator.consume(source(issued))).resolves.toMatchObject({
      status: "awaiting_human_confirmation",
    });
    const persisted = window.sessionStorage.getItem(
      ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
    );
    expect(persisted).toContain(issued.requestId);
    expect(persisted).toContain("awaiting_human_confirmation");
    expect(persisted).not.toContain(issued.ticket);
    expect(persisted).not.toContain(issued.program);
    expect(persisted).toContain("admin.media.image.save.media-picker.panel-b");
    expect(persisted).toContain(issued.ticket.slice(-43));

    const remounted = new AdminFlueComputerCoordinator({
      runtime: createAdminAssistantComputerRuntime({
        threadId: THREAD_ID,
        tabId: TAB_ID,
      }),
      postResult,
      now: () => clock,
    });
    await expect(remounted.consume(source(issued))).resolves.toMatchObject({
      status: "continuation_accepted",
      requestId: issued.requestId,
      result: {
        ok: false,
        code: "HUMAN_REQUIRED",
        output: expect.stringContaining("cancelled after the page reloaded"),
      },
    });
    await expect(remounted.confirmHumanAction({
      actionId: "admin.media.image.save.media-picker.panel-b",
      operationId: `aho_${"b".repeat(24)}`,
      outcome: "succeeded",
    })).resolves.toEqual({
      status: "ignored",
      reason: "no_pending_confirmation",
    });
    expect(postResult).toHaveBeenCalledOnce();
    expect(postResult).toHaveBeenCalledWith(expect.objectContaining({
      threadId: THREAD_ID,
      requestId: issued.requestId,
      ticket: issued.ticket,
      program: issued.program,
    }));
  });

  it("does not arm from a manual operation that started before the computer command", async () => {
    document.body.innerHTML = `
      <main>
        <button data-scalius-computer-human-confirmation="admin.media.image.generate.media-picker.panel-c">Generate image</button>
      </main>`;
    const runtime = createAdminAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const handle = observed.output.match(
      /(@r\d+\.e\d+) button "Generate image"/u,
    )?.[1];
    const postResult = vi.fn(async (payload: Parameters<typeof postAdminFlueComputerResult>[0]) => ({
      accepted: true as const,
      requestId: payload.requestId,
    }));
    const coordinator = new AdminFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
    });
    const operationId = `aho_${"d".repeat(24)}`;
    expect(coordinator.registerHumanActionStart({
      actionId: "admin.media.image.generate.media-picker.panel-c",
      operationId,
    })).toBe(false);

    const issued = await command(`click ${handle}`, 18);
    await expect(coordinator.consume(source(issued))).resolves.toMatchObject({
      status: "continuation_accepted",
      result: { ok: false, code: "BUSY" },
    });
    expect(coordinator.pendingHumanConfirmationCount()).toBe(0);
    await expect(coordinator.confirmHumanAction({
      actionId: "admin.media.image.generate.media-picker.panel-c",
      operationId,
      outcome: "succeeded",
    })).resolves.toEqual({
      status: "ignored",
      reason: "no_pending_confirmation",
    });
    expect(postResult).toHaveBeenCalledOnce();
  });

  it("cancels pending confirmation terminally so a late operation cannot post", async () => {
    document.body.innerHTML = `
      <main>
        <button data-scalius-computer-human-confirmation="admin.media.image.generate.library-page.panel-d">Generate image</button>
      </main>`;
    const runtime = createAdminAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const handle = observed.output.match(
      /(@r\d+\.e\d+) button "Generate image"/u,
    )?.[1];
    const postResult = vi.fn();
    const issued = await command(`click ${handle}`, 19);
    const cancelHandoff = vi.fn(async () => ({
      accepted: true as const,
      requestId: issued.requestId,
    }));
    const coordinator = new AdminFlueComputerCoordinator({
      runtime,
      postResult,
      cancelHandoff,
      now: () => NOW + 1_000,
    });
    await expect(coordinator.consume(source(issued))).resolves.toMatchObject({
      status: "awaiting_human_confirmation",
    });

    await expect(coordinator.cancelPendingHumanConfirmations()).resolves.toEqual({
      cancelled: 1,
      durable: 1,
      failed: 0,
    });
    expect(coordinator.pendingHumanConfirmationCount()).toBe(0);
    expect(window.sessionStorage.getItem(
      ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
    )).toContain("continuation_cancelled");
    const operationId = `aho_${"e".repeat(24)}`;
    coordinator.registerHumanActionStart({
      actionId: "admin.media.image.generate.library-page.panel-d",
      operationId,
    });
    await expect(coordinator.confirmHumanAction({
      actionId: "admin.media.image.generate.library-page.panel-d",
      operationId,
      outcome: "succeeded",
    })).resolves.toEqual({
      status: "ignored",
      reason: "no_pending_confirmation",
    });
    expect(postResult).not.toHaveBeenCalled();
    expect(cancelHandoff).toHaveBeenCalledWith({
      surface: "admin",
      threadId: THREAD_ID,
      requestId: issued.requestId,
      ticket: issued.ticket,
      program: issued.program,
    });
  });

  it("resumes with a terminal cancellation when the exact visible preview is replaced", async () => {
    document.body.innerHTML = `
      <main>
        <button data-scalius-computer-human-confirmation="admin.media.image.save.library-page.panel-e">Save generated image</button>
      </main>`;
    const runtime = createAdminAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const handle = observed.output.match(
      /(@r\d+\.e\d+) button "Save generated image"/u,
    )?.[1];
    const postResult = vi.fn(
      async (payload: Parameters<typeof postAdminFlueComputerResult>[0]) => ({
        accepted: true as const,
        requestId: payload.requestId,
      }),
    );
    const coordinator = new AdminFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
    });
    const issued = await command(`click ${handle}`, 20);
    await expect(coordinator.consume(source(issued))).resolves.toMatchObject({
      status: "awaiting_human_confirmation",
    });

    await expect(coordinator.cancelHumanAction(
      "admin.media.image.save.library-page.panel-e",
    )).resolves.toMatchObject({
      status: "continuation_accepted",
      requestId: issued.requestId,
      result: {
        ok: false,
        code: "HUMAN_REQUIRED",
        output: expect.stringContaining("cancelled before confirmation"),
      },
    });
    expect(coordinator.pendingHumanConfirmationCount()).toBe(0);
    expect(postResult).toHaveBeenCalledOnce();
    await expect(coordinator.cancelHumanAction(
      "admin.media.image.save.library-page.panel-e",
    )).resolves.toEqual({
      status: "ignored",
      reason: "no_pending_confirmation",
    });
    expect(postResult).toHaveBeenCalledOnce();
  });

  it("expires stale human confirmation without posting a continuation", async () => {
    document.body.innerHTML = `
      <main>
        <button
          data-scalius-computer-human-only
          data-scalius-computer-human-confirmation="admin.media.image.save.media-picker.panel-b"
        >Save generated image</button>
      </main>`;
    const runtime = createAdminAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const observed = await runtime.execute({
      binding: runtime.binding,
      program: "observe",
    });
    const handle = observed.output.match(
      /(@r\d+\.e\d+) button "Save generated image"/u,
    )?.[1];
    let clock = NOW + 1_000;
    const postResult = vi.fn();
    const coordinator = new AdminFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => clock,
    });
    const issued = await command(`click ${handle}`, 17);
    await expect(coordinator.consume(source(issued))).resolves.toMatchObject({
      status: "awaiting_human_confirmation",
    });
    const operationId = `aho_${"c".repeat(24)}`;
    expect(coordinator.registerHumanActionStart({
      actionId: "admin.media.image.save.media-picker.panel-b",
      operationId,
    })).toBe(true);

    clock = NOW + 120_001;
    expect(coordinator.expirePendingHumanConfirmations(clock)).toBe(1);
    expect(coordinator.pendingHumanConfirmationCount()).toBe(0);
    await expect(coordinator.confirmHumanAction({
      actionId: "admin.media.image.save.media-picker.panel-b",
      operationId,
      outcome: "succeeded",
    })).resolves.toEqual({
      status: "ignored",
      reason: "no_pending_confirmation",
    });
    expect(postResult).not.toHaveBeenCalled();
  });

  it("rejects expired, cross-thread, cross-tab, and cross-surface commands before page work", async () => {
    const runtime = createAdminAssistantComputerRuntime({ threadId: THREAD_ID, tabId: TAB_ID });
    const execute = vi.spyOn(runtime, "execute");
    const coordinator = new AdminFlueComputerCoordinator({ runtime, now: () => NOW + 120_001 });
    const issued = await command("observe", 4);

    await expect(coordinator.consume(source(issued))).resolves.toEqual({
      status: "rejected",
      reason: "expired_client_command",
    });
    await expect(coordinator.consume(source(issued, { threadId: "another-thread" }))).resolves.toEqual({
      status: "rejected",
      reason: "binding_mismatch",
    });
    await expect(coordinator.consume(source(issued, { tabId: "another-tab" }))).resolves.toEqual({
      status: "rejected",
      reason: "binding_mismatch",
    });
    await expect(coordinator.consume(source({ ...issued, surface: "storefront" }))).resolves.toEqual({
      status: "rejected",
      reason: "invalid_client_command",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes only an exact goto authorized by the latest explicit user turn", async () => {
    const navigate = vi.fn();
    const runtime = createAdminAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
      navigate,
    });
    const postResult = vi.fn(async (payload: Parameters<typeof postAdminFlueComputerResult>[0]) => ({
      accepted: true as const,
      requestId: payload.requestId,
    }));
    const coordinator = new AdminFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
    });

    const authorized = await command("goto /admin/products", 13);
    await expect(
      coordinator.consume(
        source(authorized, { latestUserMessage: "Take me to products page" }),
      ),
    ).resolves.toMatchObject({ status: "continuation_accepted" });
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenLastCalledWith("/admin/products");
    expect(postResult).toHaveBeenCalledOnce();

    const unrelated = await command("goto /admin/products", 14);
    await expect(
      coordinator.consume(
        source(unrelated, { latestUserMessage: "Take me to orders" }),
      ),
    ).resolves.toEqual({
      status: "rejected",
      reason: "navigation_not_authorized",
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(postResult).toHaveBeenCalledOnce();

    // Rejection is durable through the ticket lifetime: a later matching turn
    // cannot retroactively authorize the old command after replay/remount.
    await expect(
      coordinator.consume(
        source(unrelated, { latestUserMessage: "Take me to products" }),
      ),
    ).resolves.toMatchObject({
      status: "duplicate",
      phase: "navigation_rejected",
    });
    expect(navigate).toHaveBeenCalledOnce();

    const ambiguous = await command("goto /admin/products", 15);
    await expect(
      coordinator.consume(
        source(ambiguous, {
          latestUserMessage: "Take me to products or orders",
        }),
      ),
    ).resolves.toEqual({
      status: "rejected",
      reason: "navigation_not_authorized",
    });
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("binds visible link clicks to the same exact catalog destination intent", async () => {
    document.body.innerHTML = `
      <main>
        <a href="/admin/products">Products</a>
        <a href="/admin/products/prod_private">Private product</a>
      </main>`;
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a")];
    const clicked = vi.fn((event: Event) => event.preventDefault());
    for (const link of links) link.addEventListener("click", clicked);

    const runtime = createAdminAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
    });
    const postResult = vi.fn(
      async (payload: Parameters<typeof postAdminFlueComputerResult>[0]) => ({
        accepted: true as const,
        requestId: payload.requestId,
      }),
    );
    const coordinator = new AdminFlueComputerCoordinator({
      runtime,
      postResult,
      now: () => NOW + 1_000,
    });
    const observed = await coordinator.consume(source(await command("observe", 16)));
    if (observed.status !== "continuation_accepted") {
      throw new Error("observe failed");
    }
    const productsHandle = observed.result.output.match(
      /(@r\d+\.e\d+) link "Products"/u,
    )?.[1];
    const detailHandle = observed.result.output.match(
      /(@r\d+\.e\d+) link "Private product"/u,
    )?.[1];
    expect(productsHandle).toBeTruthy();
    expect(detailHandle).toBeTruthy();

    const unrelated = await coordinator.consume(
      source(await command(`click ${productsHandle}`, 17), {
        latestUserMessage: "How many products do we have?",
      }),
    );
    expect(unrelated).toMatchObject({
      status: "continuation_accepted",
      result: { ok: false, code: "ROUTE_BLOCKED" },
    });
    const detail = await coordinator.consume(
      source(await command(`click ${detailHandle}`, 18), {
        latestUserMessage: "Take me to a product",
      }),
    );
    expect(detail).toMatchObject({
      status: "continuation_accepted",
      result: { ok: false, code: "ROUTE_BLOCKED" },
    });
    expect(clicked).not.toHaveBeenCalled();

    const exact = await coordinator.consume(
      source(await command(`click ${productsHandle}`, 19), {
        latestUserMessage: "Take me to products page",
      }),
    );
    expect(exact).toMatchObject({
      status: "continuation_accepted",
      result: { ok: true, code: "EXECUTED" },
    });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("preserves stale-revision and sensitive-control failures and posts them as untrusted", async () => {
    document.body.innerHTML = `
      <main>
        <button data-scalius-computer-action="allow">Continue</button>
        <input type="password" aria-label="Password" value="never-leak" />
      </main>`;
    const runtime = createAdminAssistantComputerRuntime({ threadId: THREAD_ID, tabId: TAB_ID });
    const posted = vi.fn(async (payload: Parameters<typeof postAdminFlueComputerResult>[0]) => ({
      accepted: true as const,
      requestId: payload.requestId,
    }));
    const coordinator = new AdminFlueComputerCoordinator({
      runtime,
      postResult: posted,
      now: () => NOW + 1_000,
    });
    const observedCommand = await command("observe", 5);
    const observedOutcome = await coordinator.consume(source(observedCommand));
    expect(observedOutcome.status).toBe("continuation_accepted");
    if (observedOutcome.status !== "continuation_accepted") throw new Error("observe failed");
    expect(observedOutcome.result.output).not.toContain("never-leak");
    const continueHandle = observedOutcome.result.output.match(/(@r\d+\.e\d+) button "Continue"/u)?.[1];
    const protectedHandle = observedOutcome.result.output.match(/(@r\d+\.e\d+) textbox "Protected input"/u)?.[1];
    expect(continueHandle).toBeTruthy();
    expect(protectedHandle).toBeTruthy();

    document.querySelector("main")!.insertAdjacentHTML("afterbegin", "<h1>Changed</h1>");
    const staleCommand = await command(`click ${continueHandle}`, 6);
    const stale = await coordinator.consume(source(staleCommand));
    expect(stale).toMatchObject({
      status: "continuation_accepted",
      result: { ok: false, code: "STALE_CONTEXT" },
    });

    const freshObserve = await command("observe", 7);
    const fresh = await coordinator.consume(source(freshObserve));
    if (fresh.status !== "continuation_accepted") throw new Error("fresh observe failed");
    const freshProtected = fresh.result.output.match(/(@r\d+\.e\d+) textbox "Protected input"/u)?.[1];
    const sensitiveCommand = await command(`fill ${freshProtected} "stolen"`, 8);
    const sensitive = await coordinator.consume(source(sensitiveCommand));
    expect(sensitive).toMatchObject({
      status: "continuation_accepted",
      result: { ok: false, code: "SENSITIVE_CONTROL" },
    });
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("never-leak");
  });

  it("keeps a failed or uncertain post terminal and does not claim page success", async () => {
    const runtime = createAdminAssistantComputerRuntime({ threadId: THREAD_ID, tabId: TAB_ID });
    const execute = vi.spyOn(runtime, "execute");
    const postResult = vi.fn(async () => {
      throw new Error("network response lost");
    });
    const coordinator = new AdminFlueComputerCoordinator({
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
    expect(execute).toHaveBeenCalledOnce();
    expect(postResult).toHaveBeenCalledOnce();
  });

  it("persists only an opaque expiry marker so a refresh remount cannot replay itself", async () => {
    const refresh = vi.fn();
    const firstRuntime = createAdminAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
      refresh,
    });
    const issued = await command("refresh", 12);
    const first = new AdminFlueComputerCoordinator({
      runtime: firstRuntime,
      postResult: async (payload) => ({ accepted: true, requestId: payload.requestId }),
      now: () => NOW + 1_000,
    });
    await expect(first.consume(source(issued))).resolves.toMatchObject({
      status: "continuation_accepted",
    });
    expect(refresh).toHaveBeenCalledOnce();

    const persisted = window.sessionStorage.getItem(ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY);
    expect(persisted).toContain(issued.requestId);
    expect(persisted).not.toContain(issued.program);
    expect(persisted).not.toContain(issued.ticket);

    const remountedRuntime = createAdminAssistantComputerRuntime({
      threadId: THREAD_ID,
      tabId: TAB_ID,
      refresh,
    });
    const execute = vi.spyOn(remountedRuntime, "execute");
    const remounted = new AdminFlueComputerCoordinator({
      runtime: remountedRuntime,
      now: () => NOW + 2_000,
    });
    await expect(remounted.consume(source(issued))).resolves.toMatchObject({
      status: "duplicate",
      phase: "continuation_accepted",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("Admin Flue command parsing and same-origin result POST", () => {
  it("accepts only the exact beta.9 dynamic tool output contract", async () => {
    const issued = await command("observe", 10);
    expect(parseAdminFlueComputerClientCommand(issued, NOW + 1_000)).toEqual({
      ok: true,
      command: issued,
    });
    expect(parseAdminFlueComputerClientCommand({ ...issued, success: true }, NOW + 1_000)).toEqual({
      ok: false,
      reason: "invalid_client_command",
    });
  });

  it("posts only a bounded same-origin cookie request and requires exact 202 admission", async () => {
    const issued = await command("observe", 11);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/assistant/flue/computer/results");
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("same-origin");
      expect(init?.keepalive).toBe(true);
      expect([...new Headers(init?.headers).entries()].map(([name, value]) => [
        name.toLowerCase(),
        value,
      ])).toEqual([["content-type", "application/json"]]);
      await expect(new Response(init?.body).json()).resolves.toMatchObject({
        surface: "admin",
        threadId: THREAD_ID,
        requestId: issued.requestId,
      });
      return Response.json({ accepted: true, requestId: issued.requestId }, { status: 202 });
    });
    const payload = {
      surface: "admin" as const,
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

    await expect(postAdminFlueComputerResult(payload, fetcher)).resolves.toEqual({
      accepted: true,
      requestId: issued.requestId,
    });
    expect(fetcher).toHaveBeenCalledOnce();

    await expect(postAdminFlueComputerResult(payload, vi.fn(async () =>
      Response.json({ accepted: true, requestId: "wrong-request" }, { status: 202 }),
    ))).rejects.toThrow("not accepted");
  });

  it("terminally cancels a signed handoff without posting a result", async () => {
    const issued = await command("observe", 12);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/assistant/flue/computer/cancel");
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
      });
      await expect(new Response(init?.body).json()).resolves.toEqual({
        surface: "admin",
        threadId: THREAD_ID,
        requestId: issued.requestId,
        ticket: issued.ticket,
        program: issued.program,
      });
      return Response.json({
        accepted: true,
        status: "cancelled",
        requestId: issued.requestId,
      }, { status: 202 });
    });

    await expect(cancelAdminFlueComputerHandoff({
      surface: "admin",
      threadId: THREAD_ID,
      requestId: issued.requestId,
      ticket: issued.ticket,
      program: issued.program,
    }, fetcher)).resolves.toEqual({
      accepted: true,
      requestId: issued.requestId,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
