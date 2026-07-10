// @vitest-environment happy-dom

import type { FlueConversationMessage } from "@flue/sdk";
import { issueScaliusComputerCommand } from "@scalius/shared/assistant-computer-handoff";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

const THREAD_ID = "conv_abcdefghijklmnopqrstuv";
const COMPUTER_KEY = "storefront-ui-computer-test-key-at-least-32-bytes";

const flueMocks = vi.hoisted(() => ({
  snapshot: {} as {
    threadId: string | null;
    messages: FlueConversationMessage[];
    pendingSubmissionId: string | null;
    sending: boolean;
    aborting: boolean;
    state: {
      kind: "idle" | "connecting" | "connected" | "disconnected";
      message: string;
    };
    historyReady: boolean;
    sendMessage: Mock;
    abort: Mock;
    newConversation: Mock;
    canResumePreviousConversation: boolean;
    recentThreads: Array<{ threadId: string; label: string }>;
    resumeConversation: Mock;
    resumePreviousConversation: Mock;
    retry: Mock;
  },
}));

vi.mock("./useStorefrontFlueAgent", () => ({
  useStorefrontFlueAgent: () => flueMocks.snapshot,
}));

import StorefrontAssistantBubble from "./StorefrontAssistantBubble";
import {
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
  buildStorefrontAssistantPageContext,
  type StorefrontAssistantPageContextSnapshot,
} from "@/lib/assistant-page-context";
import { ASSISTANT_GEOMETRY_STORAGE_KEY } from "./assistant-geometry";
import { installMemoryBrowserStorage } from "./assistant-test-storage";
import { STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY } from "./storefront-assistant-open-state";
import { STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY } from "./storefront-assistant-session";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type StorefrontAssistantBridge = {
  getContext: () => StorefrontAssistantPageContextSnapshot | null;
  navigate: (target: unknown) => boolean;
};

function textMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
): FlueConversationMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text, state: "done" }],
  };
}

describe("StorefrontAssistantBubble Flue cutover", () => {
  let root: Root;
  let host: HTMLDivElement;
  let currentContext: StorefrontAssistantPageContextSnapshot;
  let navigate: Mock<(target: unknown) => boolean>;
  let fetchMock: Mock;

  beforeEach(() => {
    document.body.innerHTML = "";
    installMemoryBrowserStorage();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/products/rice");
    navigate = vi.fn(() => true);
    fetchMock = vi.fn(async (_input, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        requestId?: string;
      };
      return Response.json(
        {
          accepted: true,
          authoritative: false,
          status: "queued_for_agent_interpretation",
          requestId: body.requestId,
        },
        { status: 202 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    flueMocks.snapshot = {
      threadId: THREAD_ID,
      messages: [],
      pendingSubmissionId: null,
      sending: false,
      aborting: false,
      state: {
        kind: "connected",
        message: "Private shopping thread connected.",
      },
      historyReady: true,
      sendMessage: vi.fn(async () => ({ submissionId: "submission_1" })),
      abort: vi.fn(async () => true),
      newConversation: vi.fn(() => true),
      canResumePreviousConversation: false,
      recentThreads: [],
      resumeConversation: vi.fn(() => true),
      resumePreviousConversation: vi.fn(() => true),
      retry: vi.fn(),
    };

    currentContext = buildStorefrontAssistantPageContext({
      path: "/products/rice",
      route: "/products/[slug]",
      canonicalUrl: "https://shop.example.test/products/rice",
      title: "Premium Rice",
      pageKind: "product",
    });
    window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL] = currentContext;
    window.__SCALIUS_STOREFRONT_ASSISTANT__ = {
      getContext: () => currentContext,
      navigate,
    } satisfies StorefrontAssistantBridge;

    host = document.createElement("div");
    appendAssistantHost(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    delete window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL];
    delete window.__SCALIUS_STOREFRONT_ASSISTANT__;
    delete document.documentElement.dataset.storefrontAssistantHydrated;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends one bounded prompt through Flue and never calls the legacy chat endpoint", async () => {
    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await typeAssistantMessage("Do you sell shoes?");
    await click(queryButton("Send storefront assistant message"));

    expect(flueMocks.snapshot.sendMessage).toHaveBeenCalledWith(
      "Do you sell shoes?",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Request admitted. Working through the catalog",
    );
  });

  it("executes one signed same-origin computer navigation and persists the open dock", async () => {
    const issued = await issueScaliusComputerCommand({
      surface: "storefront",
      agentName: "shopping-assistant",
      instanceId: `v1.${"i".repeat(43)}`,
      program: "goto /products/everyday-shoes",
      signingKey: COMPUTER_KEY,
    });
    flueMocks.snapshot.messages = [
      textMessage(
        "user_navigation",
        "user",
        "Please take me to Everyday Shoes",
      ),
      {
        id: "assistant_navigation",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "scalius_call_navigation",
            state: "output-available",
            input: {
              program: 'call catalog.product {"slug":"everyday-shoes"}',
            },
            output: {
              ok: true,
              authoritative: true,
              data: {
                product: {
                  name: "Everyday Shoes",
                  route: "/products/everyday-shoes",
                },
              },
            },
          },
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_call_1",
            state: "output-available",
            input: { program: issued.program },
            output: issued,
          },
        ],
      },
    ];

    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await flushReact();

    expect(navigate).toHaveBeenCalledWith("/products/everyday-shoes");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/assistant/conversations/${THREAD_ID}/computer/results`,
    );
    const posted = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      result: { code: string };
    };
    expect(posted.result.code).toBe("NAVIGATED");
    expect(
      window.sessionStorage.getItem(
        STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY,
      ),
    ).toBe("open");
  });

  it("keeps the dock and launcher outside the computer observation boundary", async () => {
    document
      .querySelector<HTMLElement>("[data-assistant-page-slot]")
      ?.insertAdjacentHTML(
        "beforeend",
        '<button data-scalius-computer-action="allow">Browse products</button>',
      );
    const issued = await issueScaliusComputerCommand({
      surface: "storefront",
      agentName: "shopping-assistant",
      instanceId: `v1.${"i".repeat(43)}`,
      program: "observe",
      signingKey: COMPUTER_KEY,
    });
    flueMocks.snapshot.messages = [
      {
        id: "assistant_observe",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_call_observe",
            state: "output-available",
            input: { program: issued.program },
            output: issued,
          },
        ],
      },
    ];

    renderBubble();
    expect(
      queryButton("Open storefront assistant")?.closest(
        "[data-scalius-computer-exclude]",
      ),
    ).toBeTruthy();
    await click(queryButton("Open storefront assistant"));
    await flushReact();

    expect(
      document
        .querySelector("#storefront-assistant-panel")
        ?.hasAttribute("data-scalius-computer-exclude"),
    ).toBe(true);
    const posted = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      result: { output: string };
    };
    expect(posted.result.output).toContain("Browse products");
    expect(posted.result.output).not.toContain("New assistant conversation");
    expect(posted.result.output).not.toContain("Message storefront assistant");
    expect(posted.result.output).not.toContain("Collapse assistant");
  });

  it("blocks computer observation on private buyer pages and returns a human-required result", async () => {
    window.history.replaceState(null, "", "/checkout");
    currentContext = buildStorefrontAssistantPageContext({
      path: "/checkout",
      route: "/checkout",
      pageKind: "checkout",
    });
    const issued = await issueScaliusComputerCommand({
      surface: "storefront",
      agentName: "shopping-assistant",
      instanceId: `v1.${"i".repeat(43)}`,
      program: "observe",
      signingKey: COMPUTER_KEY,
    });
    fetchMock.mockImplementationOnce(async (_input, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        requestId: string;
        result: { code: string; changed?: boolean };
      };
      expect(body.result.code).toBe("HUMAN_REQUIRED");
      return Response.json(
        {
          accepted: true,
          authoritative: false,
          status: "queued_for_agent_interpretation",
          requestId: body.requestId,
        },
        { status: 202 },
      );
    });
    flueMocks.snapshot.messages = [
      {
        id: "assistant_private",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_call_private",
            state: "output-available",
            input: { program: issued.program },
            output: issued,
          },
        ],
      },
    ];

    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await flushReact();

    expect(navigate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain(
      "The requested page action could not finish",
    );
  });

  it("keeps Flue text compact and never renders raw tool output", async () => {
    flueMocks.snapshot.messages = [
      {
        id: "assistant_compact",
        role: "assistant",
        parts: [
          { type: "text", text: "A concise catalog answer.", state: "done" },
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "scalius_call_1",
            state: "output-available",
            input: { program: "find products shoes" },
            output: { secretRawPayload: "MUST_NOT_RENDER" },
          },
        ],
      },
    ];
    renderBubble();
    await click(queryButton("Open storefront assistant"));

    expect(document.body.textContent).toContain("A concise catalog answer.");
    expect(document.body.textContent).toContain("Catalog checked");
    expect(document.body.textContent).not.toContain("MUST_NOT_RENDER");
    expect(document.body.querySelector("table")).toBeNull();
  });

  it("does not yank an unpinned transcript and offers a jump-to-latest control", async () => {
    flueMocks.snapshot.messages = [
      textMessage("assistant_scroll_1", "assistant", "First answer"),
    ];
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await flushReact();
    const viewport = document.querySelector<HTMLElement>(
      "[data-assistant-conversation]",
    );
    expect(viewport).toBeTruthy();
    Object.defineProperties(viewport!, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    await act(async () => {
      viewport?.dispatchEvent(new Event("scroll"));
    });
    const beforeUpdate = scrollIntoView.mock.calls.length;

    flueMocks.snapshot.messages = [
      ...flueMocks.snapshot.messages,
      textMessage("assistant_scroll_2", "assistant", "Streaming update"),
    ];
    renderBubble();
    await flushReact();
    expect(scrollIntoView).toHaveBeenCalledTimes(beforeUpdate);
    await click(queryButtonText("Jump to latest"));
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(beforeUpdate);
  });

  it("restores the redacted handoff while durable history reconnects after a full navigation", async () => {
    flueMocks.snapshot.messages = [
      textMessage("user_1", "user", "Find rice"),
      textMessage("assistant_1", "assistant", "Rice is available today."),
    ];
    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await flushReact();
    expect(
      window.sessionStorage.getItem(
        STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY,
      ),
    ).toContain("Rice is available today.");

    act(() => root.unmount());
    host.remove();
    flueMocks.snapshot.messages = [];
    flueMocks.snapshot.historyReady = false;
    flueMocks.snapshot.state = {
      kind: "connecting",
      message: "Restoring this tab’s private shopping thread…",
    };
    host = document.createElement("div");
    appendAssistantHost(host);
    root = createRoot(host);
    renderBubble();
    await flushReact();

    expect(document.body.textContent).toContain("Find rice");
    expect(document.body.textContent).toContain("Rice is available today.");
    expect(document.querySelector("#storefront-assistant-panel")).toBeTruthy();
  });

  it("offers truthful retry and durable stop controls", async () => {
    flueMocks.snapshot.state = {
      kind: "disconnected",
      message: "Shopping help is disconnected.",
    };
    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await click(queryButtonText("Retry connection"));
    expect(flueMocks.snapshot.retry).toHaveBeenCalledOnce();

    flueMocks.snapshot.state = {
      kind: "connected",
      message: "Working…",
    };
    flueMocks.snapshot.sending = true;
    renderBubble();
    await flushReact();
    await click(queryButton("Stop storefront assistant request"));
    expect(flueMocks.snapshot.abort).toHaveBeenCalledOnce();
  });

  it("starts a real new thread pointer without deleting durable history", async () => {
    flueMocks.snapshot.messages = [
      textMessage("old_user", "user", "Old durable question"),
    ];
    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await click(queryButton("New assistant conversation"));
    expect(flueMocks.snapshot.newConversation).toHaveBeenCalledOnce();
    expect(
      window.sessionStorage.getItem(
        STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY,
      ),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      "Recent durable history remains available",
    );
  });

  it("exposes every bounded recent thread through one compact accessible control", async () => {
    const oldestThread = "conv_zyxwvutsrqponmlkjihgfe";
    flueMocks.snapshot.canResumePreviousConversation = true;
    flueMocks.snapshot.recentThreads = [
      {
        threadId: "conv_bcdefghijklmnopqrstuvw",
        label: "Previous thread",
      },
      { threadId: oldestThread, label: "2 threads back" },
    ];
    renderBubble();
    await click(queryButton("Open storefront assistant"));
    const history = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Assistant conversation history"]',
    );
    expect(history).toBeTruthy();
    expect(
      Array.from(history?.options ?? []).map((option) => option.text),
    ).toEqual(["Recent threads", "Previous thread", "2 threads back"]);
    await act(async () => {
      if (history) history.value = oldestThread;
      history?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(flueMocks.snapshot.resumeConversation).toHaveBeenCalledWith(
      oldestThread,
    );
    expect(document.body.textContent).toContain(
      "Reopening the previous durable thread",
    );
  });

  it("keeps keyboard docking, width, and focus behavior structural", async () => {
    renderBubble();
    await flushReact();
    const launcher = queryButton("Open storefront assistant");
    const initial = JSON.parse(
      window.localStorage.getItem(ASSISTANT_GEOMETRY_STORAGE_KEY) ?? "{}",
    ) as { launcherX: number };
    await keyDown(launcher, "ArrowLeft");
    const moved = JSON.parse(
      window.localStorage.getItem(ASSISTANT_GEOMETRY_STORAGE_KEY) ?? "{}",
    ) as { launcherX: number };
    expect(moved.launcherX).toBe(initial.launcherX - 32);

    await click(launcher);
    const panel = document.querySelector<HTMLElement>(
      "#storefront-assistant-panel",
    );
    expect(panel?.tagName).toBe("ASIDE");
    await click(queryButton("Dock on the right"));
    await click(queryButton("Dock on the left"));
    expect(
      document.querySelector<HTMLElement>("#storefront-assistant-layout")
        ?.dataset.side,
    ).toBe("start");
    await keyDown(panel, "Escape");
    expect(queryButton("Open storefront assistant")).toBeTruthy();
  });

  function renderBubble() {
    act(() => root.render(<StorefrontAssistantBubble />));
  }
});

function queryButton(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
}

function queryButtonText(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes(text),
    ) ?? null
  );
}

function appendAssistantHost(host: HTMLDivElement) {
  let layout = document.querySelector<HTMLElement>(
    "#storefront-assistant-layout",
  );
  if (!layout) {
    layout = document.createElement("div");
    layout.id = "storefront-assistant-layout";
    layout.dataset.mode = "collapsed";
    layout.dataset.side = "end";
    const page = document.createElement("div");
    page.dataset.assistantPageSlot = "";
    const dock = document.createElement("div");
    dock.dataset.assistantDockSlot = "";
    layout.append(page, dock);
    document.body.append(layout);
  }
  layout.querySelector<HTMLElement>("[data-assistant-dock-slot]")?.append(host);
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

async function keyDown(element: HTMLElement | null, key: string) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await flushReact();
}

async function typeAssistantMessage(value: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message storefront assistant"]',
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
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
