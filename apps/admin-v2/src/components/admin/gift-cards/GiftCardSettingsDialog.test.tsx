// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { giftCardsMessages } from "~/i18n/gift-cards";
import { GiftCardSettingsDialog } from "./GiftCardSettingsDialog";

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminGiftCardsSettings: mocks.read,
  putApiV1AdminGiftCardsSettings: mocks.save,
}));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ code: "BDT", symbol: "৳", fmt: String }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = giftCardsMessages.en;

const envelope = (data: unknown, status = 200) => ({ data: { success: true, data }, response: { status } });
const settings = (appDailyLimit: number, revision: number) => envelope({ appDailyLimit, appDailyLimitMinor: appDailyLimit * 100, currencyCode: "BDT", revision });

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("GiftCardSettingsDialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  const onOpenChange = vi.fn();

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

  it("loads what one app may add a day and saves a lower limit under the revision it read", async () => {
    mocks.read.mockResolvedValue(settings(1000, 3));
    mocks.save.mockResolvedValue(settings(250, 4));
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <GiftCardSettingsDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    ));
    await act(async () => undefined);
    expect(document.body.textContent).toContain(en.appDailyLimitLabel);
    const input = document.querySelector<HTMLInputElement>("#gift-card-app-daily-limit")!;
    expect(input.value).toContain("1");
    await act(async () => setValue(input, "250"));
    await act(async () => {
      document.querySelector("form#gift-card-settings")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.save).toHaveBeenCalledWith({ body: { appDailyLimit: 250, expectedRevision: 3 } });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
