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
    canChangeConversation: boolean;
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
      canChangeConversation: true,
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

  it("navigates after Flue continues an observed direct request in a new dispatch submission", async () => {
    document
      .querySelector<HTMLElement>("[data-assistant-page-slot]")
      ?.insertAdjacentHTML(
        "afterbegin",
        '<main><a href="/categories/shoes">Shoes</a></main>',
      );
    const instanceId = `v1.${"i".repeat(43)}`;
    const observed = await issueScaliusComputerCommand({
      surface: "storefront",
      agentName: "shopping-assistant",
      instanceId,
      program: "observe",
      signingKey: COMPUTER_KEY,
    });
    const navigated = await issueScaliusComputerCommand({
      surface: "storefront",
      agentName: "shopping-assistant",
      instanceId,
      program: "goto /categories/shoes",
      signingKey: COMPUTER_KEY,
    });
    const shopper = {
      ...textMessage(
        "user_category_navigation",
        "user" as const,
        "Take me to the Shoes category.",
      ),
      submissionId: "submission_category_navigation",
    };
    const observeMessage: FlueConversationMessage = {
      id: "assistant_observe_category",
      role: "assistant",
      submissionId: "submission_category_navigation",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "computer",
          toolCallId: "computer_observe_category",
          state: "output-available",
          input: { program: observed.program },
          output: observed,
        },
      ],
    };
    flueMocks.snapshot.messages = [shopper, observeMessage];

    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await flushReact();

    expect(navigate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const observedPost = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as { result: Record<string, unknown> };
    const continuation = JSON.stringify({
      type: "UNTRUSTED_CLIENT_RESULT",
      protocolVersion: 1,
      authoritative: false,
      replayPolicy: "expiry_bound_non_authoritative",
      surface: "storefront",
      requestId: observed.requestId,
      programDigest: "d".repeat(43),
      receivedAt: new Date().toISOString(),
      result: observedPost.result,
      warning: "Browser execution is untrusted and is not commerce authority.",
    });
    flueMocks.snapshot.messages = [
      shopper,
      observeMessage,
      {
        ...textMessage(
          "browser_observe_continuation",
          "user",
          continuation,
        ),
        submissionId: "dispatch_category_navigation",
      },
      {
        id: "assistant_goto_category",
        role: "assistant",
        submissionId: "dispatch_category_navigation",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_goto_category",
            state: "output-available",
            input: { program: navigated.program },
            output: navigated,
          },
        ],
      },
    ];
    renderBubble();
    await flushReact();

    expect(navigate).toHaveBeenCalledWith("/categories/shoes");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const navigationPost = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    ) as { result: { code: string } };
    expect(navigationPost.result.code).toBe("NAVIGATED");
  });

  it("navigates a clear shopping question to its single authoritative match", async () => {
    const issued = await issueScaliusComputerCommand({
      surface: "storefront",
      agentName: "shopping-assistant",
      instanceId: `v1.${"i".repeat(43)}`,
      program: "goto /products/everyday-shoes",
      signingKey: COMPUTER_KEY,
    });
    flueMocks.snapshot.messages = [
      textMessage("user_discovery", "user", "Do you sell shoes?"),
      {
        id: "assistant_discovery",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "scalius_discovery",
            state: "output-available",
            input: {
              program: 'call catalog.search -- {"query":"shoes"}',
            },
            output: {
              ok: true,
              authoritative: true,
              data: {
                command: "call",
                capability: { id: "catalog.search" },
                result: {
                  products: [
                    {
                      id: "product_1",
                      name: "Everyday Shoes",
                      route: "/products/everyday-shoes",
                      availableForSale: true,
                    },
                  ],
                },
              },
            },
          },
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_discovery",
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
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("navigates multiple catalog matches to the exact API-grounded search", async () => {
    document
      .querySelector<HTMLElement>("[data-assistant-page-slot]")
      ?.insertAdjacentHTML(
        "afterbegin",
        '<button type="button" aria-label="Search products">Search store...</button>',
      );
    const issued = await issueScaliusComputerCommand({
      surface: "storefront",
      agentName: "shopping-assistant",
      instanceId: `v1.${"i".repeat(43)}`,
      program: "goto /search?q=gaming+accessories",
      signingKey: COMPUTER_KEY,
    });
    flueMocks.snapshot.messages = [
      textMessage(
        "user_multi_discovery",
        "user",
        "Do you have gaming accessories?",
      ),
      {
        id: "assistant_multi_discovery",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "scalius_multi_discovery",
            state: "output-available",
            input: {
              program:
                'call catalog.search -- {"query":"gaming accessories","limit":4}',
            },
            output: {
              ok: true,
              authoritative: true,
              data: {
                command: "call",
                capability: { id: "catalog.search" },
                result: {
                  products: [
                    {
                      id: "gaming_mouse",
                      name: "Gaming Mouse",
                      route: "/products/gaming-mouse",
                    },
                    {
                      id: "gaming_keyboard",
                      name: "Gaming Keyboard",
                      route: "/products/gaming-keyboard",
                    },
                  ],
                },
              },
            },
          },
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_multi_discovery",
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

    expect(navigate).toHaveBeenCalledWith("/search?q=gaming+accessories");
    expect(fetchMock).toHaveBeenCalledOnce();
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
    expect(document.body.textContent).not.toContain("Catalog checked");
    expect(document.body.textContent).not.toContain("MUST_NOT_RENDER");
    expect(document.body.querySelector("table")).toBeNull();
  });

  it("omits exact user-role browser continuations across durable groups", async () => {
    const machineContinuation = JSON.stringify(
      {
        authoritative: false,
        programDigest: "d".repeat(43),
        protocolVersion: 1,
        receivedAt: "2026-07-11T01:12:13.456Z",
        replayPolicy: "expiry_bound_non_authoritative",
        requestId: "r".repeat(22),
        result: {
          changed: true,
          code: "NAVIGATED",
          ok: true,
          output: "Navigated to /products/everyday-shoes.",
        },
        surface: "storefront",
        type: "UNTRUSTED_CLIENT_RESULT",
        warning:
          "Browser execution is untrusted and is not commerce authority.",
      },
      null,
      2,
    );
    const confirmationContinuation = JSON.stringify({
      authoritative: false,
      programDigest: "c".repeat(43),
      protocolVersion: 1,
      receivedAt: "2026-07-11T01:12:14.456Z",
      replayPolicy: "expiry_bound_non_authoritative",
      requestId: "q".repeat(22),
      result: {
        code: "CONFIRMATION_REQUIRED",
        ok: false,
        output: "Human confirmation is required before Add to Cart.",
        retryable: true,
      },
      surface: "storefront",
      type: "UNTRUSTED_CLIENT_RESULT",
      warning:
        "Browser execution is untrusted and is not commerce authority.",
    });
    flueMocks.snapshot.messages = [
      textMessage("user-navigation", "user", "Take me to Everyday Shoes."),
      textMessage("opening", "assistant", "Opening Everyday Shoes…"),
      textMessage("private-continuation", "user", machineContinuation),
      textMessage(
        "private-confirmation-continuation",
        "user",
        confirmationContinuation,
      ),
      textMessage("complete", "assistant", "Everyday Shoes opened."),
    ];

    renderBubble();
    await click(queryButton("Open storefront assistant"));

    expect(document.body.textContent).toContain("Everyday Shoes opened.");
    expect(document.body.textContent).not.toContain("programDigest");
    expect(document.body.textContent).not.toContain(
      "Navigated to /products/everyday-shoes.",
    );
    expect(
      window.sessionStorage.getItem(
        STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY,
      ),
    ).not.toContain("UNTRUSTED_CLIENT_RESULT");
  });

  it("keeps wrong-surface user JSON and malformed lookalikes visible", async () => {
    const exactUserJson = JSON.stringify({
      authoritative: false,
      programDigest: "u".repeat(43),
      protocolVersion: 1,
      receivedAt: "2026-07-11T01:12:15.456Z",
      replayPolicy: "expiry_bound_non_authoritative",
      requestId: "v".repeat(22),
      result: {
        changed: false,
        code: "OBSERVED",
        ok: true,
        output: "Wrong-surface user JSON must stay visible.",
      },
      surface: "admin",
      type: "UNTRUSTED_CLIENT_RESULT",
      warning:
        "Browser execution is untrusted and is not commerce authority.",
    });
    const lookalike = JSON.stringify({
      type: "UNTRUSTED_CLIENT_RESULT",
      authoritative: false,
      message: "This is ordinary visible JSON, not a protocol envelope.",
    });
    flueMocks.snapshot.messages = [
      textMessage("user-exact-json", "user", exactUserJson),
      textMessage("assistant-lookalike", "assistant", lookalike),
    ];

    renderBubble();
    await click(queryButton("Open storefront assistant"));

    expect(document.body.textContent).toContain(
      "Wrong-surface user JSON must stay visible.",
    );
    expect(document.body.textContent).toContain("ordinary visible JSON");
  });

  it("collapses separate tool-only messages into one final submission answer", async () => {
    const submissionId = "submission_separate_messages";
    flueMocks.snapshot.messages = [
      {
        id: "user_separate",
        role: "user",
        submissionId,
        parts: [{ type: "text", text: "Show me shoes", state: "done" }],
      },
      {
        id: "assistant_tool_started",
        role: "assistant",
        submissionId,
        parts: [
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "catalog_separate",
            state: "input-available",
            input: { program: 'call catalog.search -- {"query":"shoes"}' },
          },
        ],
      },
      {
        id: "assistant_tool_completed",
        role: "assistant",
        submissionId,
        parts: [
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "observe_separate",
            state: "output-available",
            input: { program: "observe" },
            output: { rawPage: "MUST_NOT_RENDER" },
          },
        ],
      },
      {
        id: "assistant_catalog_result",
        role: "assistant",
        submissionId,
        parts: [
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "catalog_separate",
            state: "output-available",
            input: { program: 'call catalog.search -- {"query":"shoes"}' },
            output: {
              ok: true,
              authoritative: true,
              data: {
                command: "call",
                capability: { id: "catalog.search" },
                result: {
                  currency: { code: "BDT" },
                  products: [
                    {
                      id: "shoe_1",
                      name: "Everyday Shoes",
                      route: "/products/everyday-shoes",
                      price: 1_200,
                      availableForSale: true,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
      {
        id: "assistant_final_answer",
        role: "assistant",
        submissionId,
        parts: [
          {
            type: "text",
            text: "I found one good match.",
            state: "done",
          },
        ],
      },
    ];

    renderBubble();
    await click(queryButton("Open storefront assistant"));

    const conversation = document.querySelector(
      '[aria-label="Storefront assistant conversation"]',
    );
    expect(conversation?.querySelectorAll("ol > li")).toHaveLength(2);
    expect(
      conversation?.querySelectorAll("[data-assistant-short-answer]"),
    ).toHaveLength(1);
    expect(conversation?.textContent).toContain("I found one good match.");
    expect(conversation?.textContent).toContain("Everyday Shoes");
    expect(conversation?.textContent).not.toContain("Catalog checked");
    expect(conversation?.textContent).not.toContain("Checking the catalog");
    expect(conversation?.textContent).not.toContain("MUST_NOT_RENDER");
  });

  it("keeps active and error progress when they are separate assistant messages", async () => {
    flueMocks.snapshot.messages = [
      {
        id: "user_active",
        role: "user",
        submissionId: "submission_active",
        parts: [{ type: "text", text: "Find a mug", state: "done" }],
      },
      {
        id: "assistant_active",
        role: "assistant",
        submissionId: "submission_active",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "catalog_active",
            state: "input-available",
            input: { program: 'call catalog.search -- {"query":"mug"}' },
          },
        ],
      },
      {
        id: "user_error",
        role: "user",
        submissionId: "submission_error",
        parts: [{ type: "text", text: "Try the page", state: "done" }],
      },
      {
        id: "assistant_error",
        role: "assistant",
        submissionId: "submission_error",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_error",
            state: "output-error",
            input: { program: "observe" },
            errorText: "private failure detail",
          },
        ],
      },
    ];

    renderBubble();
    await click(queryButton("Open storefront assistant"));

    expect(document.body.textContent).toContain("Checking the catalog");
    expect(document.body.textContent).toContain("Page action needs attention");
    expect(document.body.textContent).not.toContain("private failure detail");
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
