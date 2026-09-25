// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { giftCardsMessages } from "~/i18n/gift-cards";
import { IssueGiftCardDialog } from "./IssueGiftCardDialog";

const mocks = vi.hoisted(() => ({ issue: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminGiftCards: mocks.issue,
  getApiV1AdminCustomers: vi.fn(),
}));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ code: "BDT", fmt: String }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => <a href="/admin/gift-cards/gc_1" onClick={onClick}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = giftCardsMessages.en;
const CODE = "ABCD-EFGH-JKMN-7K2Q";

const issued = {
  data: {
    success: true,
    data: {
      code: CODE,
      giftCard: { id: "gc_1", last4: "7K2Q", currencyCode: "BDT", balanceMinor: 50_000, initialAmountMinor: 50_000 },
    },
  },
  response: { status: 201 },
};
const failed = { error: { success: false, error: { code: "INTERNAL", message: "Down" } }, response: { status: 503 } };

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("IssueGiftCardDialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  const render = (open: boolean) =>
    act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <IssueGiftCardDialog open={open} onOpenChange={() => undefined} />
      </QueryClientProvider>,
    ));

  const fillAndSubmit = async () => {
    await act(async () => setValue(document.querySelector<HTMLInputElement>("#gift-card-amount")!, "500"));
    const notify = document.querySelector<HTMLButtonElement>("#gift-card-notify")!;
    if (notify.getAttribute("data-state") === "checked") await act(async () => notify.click());
    await act(async () => {
      document.querySelector("form#issue-gift-card")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
  });

  it("retries with the same request key, shows the code once and forgets it on close", async () => {
    mocks.issue.mockResolvedValueOnce(failed).mockResolvedValueOnce(issued).mockResolvedValueOnce(issued);
    await render(true);

    await fillAndSubmit();
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(CODE);

    await act(async () => {
      document.querySelector("form#issue-gift-card")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.issue).toHaveBeenCalledTimes(2);
    const first = mocks.issue.mock.calls[0]![0].body;
    const second = mocks.issue.mock.calls[1]![0].body;
    expect(second.requestKey).toBe(first.requestKey);
    expect(second).toMatchObject({ amount: 500, expiresAt: null, notify: false });
    expect(document.body.textContent).toContain(CODE);
    expect(document.body.textContent).toContain(en.codeWarning);
    // The code lives in no query and never in the address.
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(CODE);
    expect(window.location.href).not.toContain(CODE);

    await render(false);
    expect(document.body.textContent).not.toContain(CODE);

    await render(true);
    expect(document.body.textContent).not.toContain(CODE);
    await fillAndSubmit();
    expect(mocks.issue.mock.calls[2]![0].body.requestKey).not.toBe(first.requestKey);
  });

  it("asks where to send the card when there is no customer or recipient", async () => {
    await render(true);
    await act(async () => setValue(document.querySelector<HTMLInputElement>("#gift-card-amount")!, "500"));
    await act(async () => {
      document.querySelector("form#issue-gift-card")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(en.notifyNeedsTarget);
  });
});
