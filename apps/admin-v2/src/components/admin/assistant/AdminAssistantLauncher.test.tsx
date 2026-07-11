// @vitest-environment happy-dom

import {
  FlueApiError,
  type AgentConversationObservationSnapshot,
  type FlueConversationMessage,
  type FlueConversationPart,
} from "@flue/sdk";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";

const THREAD_ID = "conv_abcdefghijklmnopqrstuv";

const sdkMocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const send = vi.fn();
  const abort = vi.fn();
  const history = vi.fn();
  const refresh = vi.fn();
  const close = vi.fn();
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const observe = vi.fn();
  const createFlueClient = vi.fn();
  const state: { snapshot: AgentConversationObservationSnapshot } = {
    snapshot: {
      conversation: undefined,
      offset: undefined,
      phase: "absent",
      error: undefined,
    },
  };
  const observation = {
    getSnapshot: () => state.snapshot,
    subscribe,
    refresh,
    close,
  };
  const client = {
    agents: {
      send,
      abort,
      history,
      observe,
    },
  };
  observe.mockReturnValue(observation);
  createFlueClient.mockReturnValue(client);
  return {
    abort,
    client,
    close,
    createFlueClient,
    listeners,
    observation,
    observe,
    refresh,
    history,
    send,
    state,
    subscribe,
  };
});

const routerMocks = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@flue/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@flue/sdk")>()),
  createFlueClient: sdkMocks.createFlueClient,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => routerMocks.navigate,
}));

import { AdminAssistantLauncher } from "./AdminAssistantLauncher";
import {
  ADMIN_ASSISTANT_CONVERSATION_HISTORY_STORAGE_KEY,
  ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
} from "./admin-assistant-transcript";
import { ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY } from "./computer/flue-bridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AdminAssistantLauncher Flue cutover", () => {
  let root: Root;
  let host: HTMLDivElement;
  let computerResultFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      THREAD_ID,
    );
    window.history.replaceState({}, "", "/admin");
    setViewportWidth(1024);

    sdkMocks.listeners.clear();
    sdkMocks.send.mockReset();
    sdkMocks.abort.mockReset();
    sdkMocks.history.mockReset();
    sdkMocks.refresh.mockReset();
    sdkMocks.close.mockReset();
    sdkMocks.subscribe.mockClear();
    sdkMocks.observe.mockClear();
    sdkMocks.createFlueClient.mockClear();
    sdkMocks.observe.mockReturnValue(sdkMocks.observation);
    sdkMocks.createFlueClient.mockReturnValue(sdkMocks.client);
    sdkMocks.state.snapshot = liveSnapshot();
    sdkMocks.send.mockResolvedValue({
      streamUrl: `https://dashboard.test/api/assistant/flue/agents/admin-copilot/${THREAD_ID}`,
      offset: "opaque-offset-1",
      submissionId: "submission-1",
    });
    sdkMocks.abort.mockResolvedValue({ aborted: true });
    sdkMocks.history.mockImplementation(async () => {
      const conversation = sdkMocks.state.snapshot.conversation;
      const messages = conversation?.messages ?? [];
      const settlements = [...(conversation?.settlements ?? [])];
      const settledIds = new Set(settlements.map((entry) => entry.submissionId));
      for (const submissionId of messages.flatMap((entry) =>
        entry.submissionId ? [entry.submissionId] : [])) {
        if (!settledIds.has(submissionId)) {
          settlements.push({ submissionId, outcome: "aborted" });
        }
      }
      return {
        v: 1 as const,
        conversationId: THREAD_ID,
        offset: "opaque-history-after-stop",
        messages,
        settlements,
      };
    });
    routerMocks.navigate.mockReset();
    routerMocks.navigate.mockResolvedValue(undefined);

    computerResultFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      return Response.json(
        { accepted: true, requestId: body.requestId },
        { status: 202 },
      );
    });
    vi.stubGlobal("fetch", computerResultFetch);

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    act(() => root.unmount());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not mount the assistant workspace for a non-super-admin", async () => {
    renderLauncher(
      <section data-route-content="">Products route</section>,
      { isSuperAdmin: false, permissions: ["products.view"] },
    );
    await flushReact();

    expect(document.body.textContent).toContain("Products route");
    expect(getAssistantWorkspace()).toBeNull();
    expect(queryButton("Open admin assistant")).toBeNull();
    expect(sdkMocks.createFlueClient).not.toHaveBeenCalled();
  });

  it("renders one floating panel and real left/right workspace columns", async () => {
    renderLauncher();

    expect(getAssistantWorkspace()?.dataset.mode).toBe("closed");
    const trigger = queryButton("Open admin assistant");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    await click(trigger);
    expect(getAssistantPanel()?.getAttribute("data-assistant-mode")).toBe(
      "floating",
    );
    expect(getAssistantPanel()?.hasAttribute("data-scalius-computer-exclude")).toBe(
      true,
    );
    expect(queryButton("Move assistant")).toBeTruthy();
    expect(queryButton("Resize assistant")).toBeTruthy();

    await click(queryButton("Dock assistant left"));
    expect(getAssistantWorkspace()?.dataset.mode).toBe("docked");
    expect(getAssistantWorkspace()?.dataset.side).toBe("start");
    expect(getAssistantPanel()?.closest("[data-assistant-dock-slot]")).toBe(
      getAssistantDockSlot(),
    );

    await click(queryButton("Dock assistant right"));
    expect(getAssistantWorkspace()?.dataset.side).toBe("end");
    expect(
      queryButton("Dock assistant right")?.getAttribute("aria-pressed"),
    ).toBe("true");

    await click(queryButton("Minimize admin assistant"));
    expect(getAssistantPanel()).toBeNull();
    expect(getAssistantWorkspace()?.dataset.mode).toBe("closed");
  });

  it("keeps the same durable thread and panel while routed content changes", async () => {
    renderLauncher(<section data-route-content="">Products route</section>);
    await click(queryButton("Open admin assistant"));
    await click(queryButton("Dock assistant right"));
    const panelBeforeRouteChange = getAssistantPanel();

    await emitSnapshot(
      liveSnapshot([
        message("assistant-1", "assistant", [
          { type: "text", text: "Products are ready.", state: "done" },
        ]),
      ]),
    );

    renderLauncher(<section data-route-content="">Orders route</section>);
    await flushReact();

    expect(getAssistantPanel()).toBe(panelBeforeRouteChange);
    expect(document.body.textContent).toContain("Products are ready.");
    expect(getAssistantWorkspace()?.dataset.mode).toBe("docked");
    expect(sdkMocks.createFlueClient).toHaveBeenCalledTimes(1);
    expect(sdkMocks.observe).toHaveBeenCalledTimes(1);
    expect(
      window.sessionStorage.getItem(
        ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      ),
    ).toBe(THREAD_ID);
  });

  it("starts a real new thread, retains prior history, and reconnects it after remount", async () => {
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    expect(queryButton("New assistant conversation")).toBeTruthy();

    await click(queryButton("New assistant conversation"));
    const nextThreadId = window.sessionStorage.getItem(
      ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
    );
    expect(nextThreadId).toMatch(/^conv_[A-Za-z0-9_-]{22}$/u);
    expect(nextThreadId).not.toBe(THREAD_ID);
    expect(
      JSON.parse(
        window.sessionStorage.getItem(
          ADMIN_ASSISTANT_CONVERSATION_HISTORY_STORAGE_KEY,
        ) ?? "[]",
      ),
    ).toEqual([THREAD_ID, nextThreadId]);
    expect(sdkMocks.observe).toHaveBeenLastCalledWith(
      "admin-copilot",
      nextThreadId,
      { live: "long-poll" },
    );
    expect(queryButton("Open assistant conversation history")?.disabled).toBe(
      false,
    );
    await pointerDown(queryButton("Open assistant conversation history"));
    const historyMenu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(historyMenu?.hasAttribute("data-scalius-computer-exclude")).toBe(
      true,
    );
    await keyDown(historyMenu, "Escape");

    await emitSnapshot(
      liveSnapshot([
        message("assistant-new", "assistant", [
          {
            type: "text",
            text: "This is the new durable conversation.",
            state: "done",
          },
        ]),
      ]),
    );

    act(() => root.unmount());
    await nextMacrotask();
    host.remove();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await flushReact();

    expect(sdkMocks.observe).toHaveBeenLastCalledWith(
      "admin-copilot",
      nextThreadId,
      { live: "long-poll" },
    );
    expect(document.body.textContent).toContain(
      "This is the new durable conversation.",
    );
  });

  it("sends only the typed prompt through the same-origin Flue facade", async () => {
    const secretInput = document.createElement("input");
    secretInput.value = "SuperSecret123";
    document.body.append(secretInput);

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Take me to products");
    await click(queryButton("Send assistant message"));
    await flushReact();

    expect(sdkMocks.createFlueClient).toHaveBeenCalledWith({
      baseUrl: "/api/assistant/flue",
    });
    expect(sdkMocks.observe).toHaveBeenCalledWith(
      "admin-copilot",
      THREAD_ID,
      { live: "long-poll" },
    );
    expect(sdkMocks.send).toHaveBeenCalledWith(
      "admin-copilot",
      THREAD_ID,
      expect.objectContaining({
        message: "Take me to products",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.stringify(sdkMocks.send.mock.calls)).not.toContain(
      "SuperSecret123",
    );
    expect(document.body.textContent).toContain("Take me to products");
    expect(queryButton("Stop assistant")).toBeTruthy();

    await emitSnapshot(
      liveSnapshot(
        [
          message(
            "user-1",
            "user",
            [{ type: "text", text: "Take me to products", state: "done" }],
            "submission-1",
          ),
          message(
            "assistant-1",
            "assistant",
            [{ type: "text", text: "I am on it.", state: "done" }],
            "submission-1",
          ),
        ],
        [{ submissionId: "submission-1", outcome: "completed" }],
      ),
    );

    expect(document.body.textContent).toContain("I am on it.");
    expect(queryButton("Send assistant message")).toBeTruthy();
  });

  it("reconciles a durable echo that wins the admission race without sticking busy", async () => {
    const admission = deferred<{
      streamUrl: string;
      offset: string;
      submissionId: string;
    }>();
    sdkMocks.send.mockReturnValueOnce(admission.promise);
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Fast answer please");
    await click(queryButton("Send assistant message"));

    await emitSnapshot(
      liveSnapshot(
        [
          message(
            "user-fast",
            "user",
            [{ type: "text", text: "Fast answer please", state: "done" }],
            "submission-fast",
          ),
          message(
            "assistant-fast",
            "assistant",
            [{ type: "text", text: "Done.", state: "done" }],
            "submission-fast",
          ),
        ],
        [{ submissionId: "submission-fast", outcome: "completed" }],
      ),
    );
    admission.resolve({
      streamUrl: `https://dashboard.test/api/assistant/flue/agents/admin-copilot/${THREAD_ID}`,
      offset: "opaque-fast",
      submissionId: "submission-fast",
    });
    await flushReact();

    expect(queryButton("Send assistant message")).toBeTruthy();
    expect(queryButton("Stop assistant")).toBeNull();
    expect(
      Array.from(
        document.querySelectorAll('[data-assistant-message-role="user"]'),
      ).map((entry) => entry.textContent),
    ).toEqual(["Fast answer please"]);
  });

  it("hydrates canonical Flue messages in durable order", async () => {
    sdkMocks.state.snapshot = liveSnapshot([
      message("user-1", "user", [
        { type: "text", text: "First", state: "done" },
      ]),
      message("assistant-1", "assistant", [
        { type: "text", text: "Second", state: "done" },
      ]),
    ]);

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await flushReact();

    const messages = Array.from(
      document.querySelectorAll<HTMLElement>("[data-assistant-message-role]"),
    );
    expect(messages.map((entry) => entry.textContent)).toEqual([
      "First",
      "Second",
    ]);
    expect(sdkMocks.subscribe).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-assistant-transcript-state="disconnected"]'),
    ).toBeNull();
  });

  it("shows truthful admission failure and retries a failed observation", async () => {
    sdkMocks.send.mockRejectedValueOnce(new Error("internal secret"));
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Help me");
    await click(queryButton("Send assistant message"));
    await flushReact();

    expect(document.body.textContent).toContain(
      "Assistant request failed before it was admitted. Nothing was changed.",
    );
    expect(document.body.textContent).not.toContain("internal secret");

    await emitSnapshot({
      conversation: undefined,
      offset: undefined,
      phase: "error",
      error: new Error("private transport detail"),
    });
    expect(
      document.querySelector('[data-assistant-transcript-state="disconnected"]'),
    ).toBeTruthy();
    await click(queryButton("Retry transcript connection"));
    expect(sdkMocks.refresh).toHaveBeenCalledOnce();
  });

  it("keeps Stop required after a blocked send until the idle thread is durably unlocked", async () => {
    sdkMocks.send.mockRejectedValueOnce(
      new FlueApiError(409, {
        error: {
          code: "ADMIN_FLUE_ADMISSION_BLOCKED",
          message: "Stop is still being reconciled",
        },
      }),
    );
    sdkMocks.abort.mockResolvedValueOnce({ aborted: false });
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Help me");
    await click(queryButton("Send assistant message"));
    await flushReact();

    expect(document.body.textContent).toContain(
      "This thread has an unfinished Stop barrier. Complete Stop before sending another request.",
    );
    expect(queryButton("Stop assistant")).toBeTruthy();
    expect(queryButton("Send assistant message")).toBeNull();

    await click(queryButton("Stop assistant"));
    await flushReact();
    expect(sdkMocks.abort).toHaveBeenCalledOnce();
    expect(queryButton("Stop assistant")).toBeNull();
    expect(queryButton("Send assistant message")).toBeTruthy();
  });

  it("executes a signed computer navigation automatically and renders no link card", async () => {
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    const requestId = "r".repeat(22);
    const program = "goto /admin/products";
    const command = {
      type: "client_command",
      capability: "computer",
      protocolVersion: 1,
      status: "awaiting_client_execution",
      authoritative: false,
      replayPolicy: "client_dedupe_request_id_until_expiry",
      surface: "admin",
      requestId,
      program,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      ticket: `${"t".repeat(16)}.${"s".repeat(43)}`,
    } as const;

    await emitSnapshot(
      liveSnapshot([
        message("user-navigation", "user", [
          {
            type: "text",
            text: "Take me to products page",
            state: "done",
          },
        ]),
        message("assistant-computer", "assistant", [
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "tool-computer-1",
            state: "output-available",
            input: { program },
            output: command,
          },
        ]),
      ]),
    );

    await vi.waitFor(() => {
      expect(routerMocks.navigate).toHaveBeenCalledWith({
        to: "/admin/products",
      });
      expect(computerResultFetch).toHaveBeenCalledOnce();
    });
    expect(String(computerResultFetch.mock.calls[0]?.[0])).toBe(
      "/api/assistant/flue/computer/results",
    );
    expect(document.body.textContent).not.toContain("Page command recorded");
    expect(
      document.querySelector('[data-assistant-tool="computer"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(command.ticket);
    expect(queryButton("Open Products")).toBeNull();
    expect(
      window.sessionStorage.getItem(
        ADMIN_FLUE_COMPUTER_DEDUPE_STORAGE_KEY,
      ),
    ).toContain(requestId);
  });

  it("blocks New and history switching until a settled replay page command finishes", async () => {
    const continuation = deferred<Response>();
    computerResultFetch.mockReturnValueOnce(continuation.promise);
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    const requestId = "q".repeat(22);
    await emitSnapshot(
      liveSnapshot([
        message("assistant-replay", "assistant", [
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "tool-replay-1",
            state: "output-available",
            input: { program: "observe" },
            output: {
              type: "client_command",
              capability: "computer",
              protocolVersion: 1,
              status: "awaiting_client_execution",
              authoritative: false,
              replayPolicy: "client_dedupe_request_id_until_expiry",
              surface: "admin",
              requestId,
              program: "observe",
              expiresAt: new Date(Date.now() + 120_000).toISOString(),
              ticket: `${"t".repeat(16)}.${"s".repeat(43)}`,
            },
          },
        ]),
      ]),
    );
    await vi.waitFor(() => expect(computerResultFetch).toHaveBeenCalledOnce());
    const newConversation = queryButton("New assistant conversation");
    expect(newConversation?.disabled).toBe(true);
    const before = window.sessionStorage.getItem(
      ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
    );
    await click(newConversation);
    expect(
      window.sessionStorage.getItem(
        ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      ),
    ).toBe(before);

    continuation.resolve(
      Response.json({ accepted: true, requestId }, { status: 202 }),
    );
    await vi.waitFor(() => {
      expect(queryButton("New assistant conversation")?.disabled).toBe(false);
    });
    await click(queryButton("New assistant conversation"));
    expect(
      window.sessionStorage.getItem(
        ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      ),
    ).not.toBe(before);
  });

  it("hides terminal tool-only protocol messages and their JSON", async () => {
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    const giantValue = `private-giant-${"x".repeat(2_000)}`;
    await emitSnapshot(
      liveSnapshot([
        message("assistant-tool", "assistant", [
          {
            type: "reasoning",
            text: "private model reasoning must not render",
            state: "done",
          },
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "tool-scalius-1",
            state: "output-available",
            input: { program: "show admin.dashboard" },
            output: {
              ok: true,
              authoritative: true,
              data: { giantValue },
            },
          },
        ]),
      ]),
    );

    expect(document.body.textContent).not.toContain("Scalius result ready");
    expect(document.body.textContent).not.toContain(giantValue);
    expect(document.body.textContent).not.toContain(
      "private model reasoning must not render",
    );
    expect(
      document.querySelector('[data-assistant-tool="scalius"]'),
    ).toBeNull();
  });

  it("aborts active durable work through the exact thread", async () => {
    sdkMocks.state.snapshot = liveSnapshot([
      message(
        "user-active",
        "user",
        [{ type: "text", text: "Do the task", state: "done" }],
        "submission-active",
      ),
    ]);
    renderLauncher();
    await click(queryButton("Open admin assistant"));

    await click(queryButton("Stop assistant"));
    expect(sdkMocks.abort).toHaveBeenCalledWith(
      "admin-copilot",
      THREAD_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(sdkMocks.history).toHaveBeenCalledWith(
      "admin-copilot",
      THREAD_ID,
      { signal: expect.any(AbortSignal) },
    );
    expect(sdkMocks.refresh).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain(
      "Stop recorded. Pending page actions were cancelled and the durable thread is no longer running.",
    );

    await emitSnapshot(
      liveSnapshot(
        [
          message(
            "user-active",
            "user",
            [{ type: "text", text: "Do the task", state: "done" }],
            "submission-active",
          ),
        ],
        [{ submissionId: "submission-active", outcome: "aborted" }],
      ),
    );
    expect(document.body.textContent).toContain(
      "Assistant work stopped. Review any page changes already completed before continuing.",
    );
  });

  it("keeps Stop visible and locked after an admission abort cannot be confirmed", async () => {
    sdkMocks.send.mockImplementationOnce(
      async (
        _agentName: string,
        _threadId: string,
        options: { signal?: AbortSignal },
      ) =>
        await new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );
    sdkMocks.abort
      .mockRejectedValueOnce(new Error("abort transport unavailable"))
      .mockResolvedValueOnce({ aborted: false });
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Do the task");
    await click(queryButton("Send assistant message"));

    await click(queryButton("Stop assistant"));
    await flushReact();
    expect(document.body.textContent).toContain(
      "The stop request could not be confirmed. The assistant may still be working.",
    );
    expect(queryButton("Stop assistant")).toBeTruthy();
    expect(queryButton("Send assistant message")).toBeNull();

    await click(queryButton("Stop assistant"));
    await flushReact();
    expect(sdkMocks.abort).toHaveBeenCalledTimes(2);
    expect(queryButton("Stop assistant")).toBeNull();
    expect(queryButton("Send assistant message")).toBeTruthy();
  });

  it("does not claim a stop when Flue reports the thread was already idle", async () => {
    sdkMocks.state.snapshot = liveSnapshot([
      message(
        "user-raced",
        "user",
        [{ type: "text", text: "Do the quick task", state: "done" }],
        "submission-raced",
      ),
    ]);
    sdkMocks.abort.mockResolvedValueOnce({ aborted: false });
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await click(queryButton("Stop assistant"));

    expect(sdkMocks.history).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain(
      "The assistant had already finished, so there was nothing to stop.",
    );
    expect(document.body.textContent).not.toContain(
      "Stop recorded. Pending page actions were cancelled and the durable thread is no longer running.",
    );
    expect(queryButton("Stop assistant")).toBeNull();
  });

  it("follows live output only while the merchant remains near the bottom", async () => {
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    const end = document.querySelector<HTMLElement>(
      "[data-assistant-conversation-end]",
    );
    const log = document.querySelector<HTMLElement>(
      '[role="log"][aria-label="Assistant conversation"]',
    );
    expect(end).toBeTruthy();
    expect(log).toBeTruthy();
    const scrollIntoView = vi.fn();
    if (end) end.scrollIntoView = scrollIntoView;

    await emitSnapshot(
      liveSnapshot([
        message("user-scroll", "user", [
          { type: "text", text: "Long answer", state: "done" },
        ]),
        message("assistant-scroll", "assistant", [
          { type: "text", text: "First chunk", state: "streaming" },
        ]),
      ]),
    );
    expect(scrollIntoView).toHaveBeenCalled();

    Object.defineProperties(log!, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    log?.dispatchEvent(new Event("scroll", { bubbles: true }));
    const callsWhileReading = scrollIntoView.mock.calls.length;

    await emitSnapshot(
      liveSnapshot([
        message("user-scroll", "user", [
          { type: "text", text: "Long answer", state: "done" },
        ]),
        message("assistant-scroll", "assistant", [
          {
            type: "text",
            text: "First chunk and another chunk",
            state: "streaming",
          },
        ]),
      ]),
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(callsWhileReading);

    await emitSnapshot(
      liveSnapshot([
        message("user-scroll", "user", [
          { type: "text", text: "Long answer", state: "done" },
        ]),
        message("assistant-scroll", "assistant", [
          { type: "text", text: "Finished", state: "done" },
        ]),
        message("user-new", "user", [
          { type: "text", text: "My next question", state: "done" },
        ]),
      ]),
    );
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsWhileReading);
  });

  it("keeps complete mobile dialog focus and inert semantics", async () => {
    setViewportWidth(390);
    renderLauncher(<button>Page action</button>);
    const trigger = queryButton("Open admin assistant");
    trigger?.focus();
    await click(trigger);
    await nextMacrotask();

    const page = document.querySelector<HTMLElement>(
      "[data-assistant-page-slot]",
    );
    const dialog = document.querySelector<HTMLElement>(
      '[data-assistant-modal-boundary][role="dialog"]',
    );
    expect(getAssistantWorkspace()?.dataset.mobile).toBe("true");
    expect(page?.hasAttribute("inert")).toBe(true);
    expect(page?.getAttribute("aria-hidden")).toBe("true");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");

    await keyDown(dialog, "Escape");
    await nextMacrotask();
    expect(page?.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);
  });

  it("renders streamed markdown as compact chat typography", async () => {
    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await emitSnapshot(
      liveSnapshot([
        message("assistant-markdown", "assistant", [
          {
            type: "text",
            text:
              "Use **Products** for catalog edits.\n\n1. Open `Products`.\n2. Review changes.",
            state: "done",
          },
        ]),
      ]),
    );

    expect(document.body.textContent).toContain("Use Products for catalog edits.");
    expect(document.body.textContent).not.toContain("**Products**");
    expect(document.querySelector("strong")?.textContent).toBe("Products");
    expect(document.querySelector("code")?.textContent).toBe("Products");
    expect(document.querySelectorAll("ol li")).toHaveLength(2);
  });

  function renderLauncher(
    children?: ReactNode,
    access: { isSuperAdmin?: boolean; permissions?: string[] } = {
      isSuperAdmin: true,
    },
  ) {
    act(() => {
      root.render(
        <PermissionProvider {...access}>
          <AdminAssistantLauncher>{children}</AdminAssistantLauncher>
        </PermissionProvider>,
      );
    });
  }
});

function liveSnapshot(
  messages: FlueConversationMessage[] = [],
  settlements: NonNullable<
    AgentConversationObservationSnapshot["conversation"]
  >["settlements"] = [],
): AgentConversationObservationSnapshot {
  return {
    conversation: {
      conversationId: THREAD_ID,
      messages,
      settlements,
    },
    offset: "opaque-offset-live",
    phase: "live",
    error: undefined,
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  parts: FlueConversationPart[],
  submissionId?: string,
): FlueConversationMessage {
  return { id, role, parts, ...(submissionId ? { submissionId } : {}) };
}

async function emitSnapshot(snapshot: AgentConversationObservationSnapshot) {
  await act(async () => {
    sdkMocks.state.snapshot = snapshot;
    for (const listener of sdkMocks.listeners) listener();
  });
  await flushReact();
}

function queryButton(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
}

function getAssistantPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'aside[aria-label="Admin assistant"]',
  );
}

function getAssistantWorkspace(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    "[data-admin-assistant-workspace]",
  );
}

function getAssistantDockSlot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-assistant-dock-slot]");
}

async function click(element: HTMLElement | null) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await flushReact();
}

async function pointerDown(element: HTMLElement | null) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  });
  await flushReact();
}

async function keyDown(
  element: EventTarget | null,
  key: string,
  options: KeyboardEventInit = {},
) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    );
  });
  await flushReact();
}

async function typeAssistantMessage(value: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message admin assistant"]',
  );
  expect(textarea).toBeTruthy();

  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(textarea, value);
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flushReact();
}

async function flushReact() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

async function nextMacrotask() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}
