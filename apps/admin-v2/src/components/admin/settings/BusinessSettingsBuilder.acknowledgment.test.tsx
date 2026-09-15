// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("~/lib/api-functions/settings", () => ({
  getBusinessSettings: api.get,
  updateBusinessSettings: api.update,
}));
vi.mock("sonner", () => ({ toast: { success: api.success, error: api.error } }));
vi.mock("../shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("../media-manager", () => ({
  MediaManager: ({ trigger }: { trigger: ReactNode }) => trigger,
}));

import BusinessSettingsBuilder from "./BusinessSettingsBuilder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function settings(invoiceFooterText: string) {
  return {
    companyName: "Merchant",
    legalName: "",
    taxId: "",
    phone: "",
    email: "support@example.test",
    addressLine1: "",
    addressLine2: "",
    city: "",
    stateRegion: "",
    postalCode: "",
    country: "Bangladesh",
    invoicePrefix: "INV",
    invoiceLogoUrl: "",
    invoiceFooterText,
  };
}

describe("BusinessSettingsBuilder save acknowledgment", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function settle() {
    for (let pass = 0; pass < 3; pass += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <BusinessSettingsBuilder />
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  function footer() {
    return host.querySelector<HTMLTextAreaElement>("#invoice-footer-text")!;
  }

  function typeFooter(value: string) {
    act(() => {
      const input = footer();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function button(label: string) {
    return [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
      node.textContent?.includes(label),
    );
  }

  it("preserves a post-submit revert through stale read, failed confirmation, and Retry", async () => {
    const background = deferred<Record<string, unknown>>();
    const write = deferred<{ message: string }>();
    let stored = settings("before");
    api.get
      .mockResolvedValueOnce(stored)
      .mockImplementationOnce(() => background.promise)
      .mockRejectedValueOnce(new Error("Confirming read failed"))
      .mockImplementationOnce(async () => stored);
    api.update.mockReturnValueOnce(write.promise);

    await render();
    typeFooter("after");
    act(() => button("Save business")?.click());
    typeFooter("before");

    act(() => { void client.refetchQueries({ queryKey: ["settings", "business"] }); });
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await act(async () => {
      background.resolve(settings("before"));
      await Promise.resolve();
      stored = settings("after");
      write.resolve({ message: "Saved" });
    });
    await settle();

    expect(host.textContent).toContain("Business identity unavailable");
    expect(button("Retry")).toBeTruthy();
    act(() => button("Retry")?.click());
    await settle();

    expect(footer().value).toBe("before");
    expect(button("Save business")).toBeTruthy();
    act(() => button("Reset")?.click());
    expect(footer().value).toBe("after");
  });
});
