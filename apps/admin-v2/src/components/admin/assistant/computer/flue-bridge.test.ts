// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { issueScaliusComputerCommand } from "@scalius/shared/assistant-computer-handoff";

import {
  ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
  AdminFlueComputerCoordinator,
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

function source(output: unknown, overrides: Partial<{ threadId: string; tabId: string }> = {}) {
  return {
    threadId: overrides.threadId ?? THREAD_ID,
    tabId: overrides.tabId ?? TAB_ID,
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
});
