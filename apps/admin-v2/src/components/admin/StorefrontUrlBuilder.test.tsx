// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "~/lib/query-keys";
import { StorefrontUrlBuilder } from "./StorefrontUrlBuilder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const storefrontUrlApi = vi.hoisted(() => ({
  getStorefrontUrl: vi.fn(),
  updateStorefrontUrl: vi.fn(),
}));

vi.mock("~/lib/api-functions/storefront-url", () => storefrontUrlApi);
vi.mock("./shared/UnsavedChangesGuard", () => ({
  UnsavedChangesGuard: () => null,
}));
vi.mock("./settings/HomepagePresentationBuilder", () => ({
  HomepagePresentationBuilder: () => null,
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

async function flushAsyncWork() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

function getButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`Expected button labeled ${label}`);
  return button;
}

async function setStoreUrl(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>("#storefront-url");
  if (!input) throw new Error("Expected Store URL input");
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushAsyncWork();
    }
  }

  throw lastError;
}

describe("StorefrontUrlBuilder", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let invalidateQueriesSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");
    storefrontUrlApi.getStorefrontUrl.mockResolvedValue({
      storefrontUrl: "https://shop.example.com",
    });
    storefrontUrlApi.updateStorefrontUrl.mockResolvedValue({
      message: "ok",
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    invalidateQueriesSpy.mockRestore();
  });

  async function renderBuilder() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <StorefrontUrlBuilder />
        </QueryClientProvider>,
      );
    });
    await waitFor(() => {
      expect(host.textContent).toContain("Save URL");
    });
  }

  it("shows a clean saved state and explains where the origin is used", async () => {
    await renderBuilder();

    expect(host.textContent).toContain(
      "Used for storefront links, previews, discovery files, and cache refreshes.",
    );
    expect(getButton(host, "Reset").disabled).toBe(true);
    expect(getButton(host, "Save URL").disabled).toBe(true);
  });

  it("rejects a relative draft without calling the API", async () => {
    await renderBuilder();
    await setStoreUrl(host, "/preview");

    expect(host.textContent).toContain(
      "Use an HTTPS origin without a path, query, credentials, or fragment.",
    );
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Open storefront"]')
        ?.disabled,
    ).toBe(true);
    expect(getButton(host, "Save URL").disabled).toBe(true);
    expect(storefrontUrlApi.updateStorefrontUrl).not.toHaveBeenCalled();
  });

  it("normalizes and saves a changed origin, then invalidates the SEO live proof", async () => {
    await renderBuilder();
    await setStoreUrl(host, "https://new-shop.example.com/");

    expect(getButton(host, "Reset").disabled).toBe(false);
    expect(getButton(host, "Save URL").disabled).toBe(false);

    await act(async () => {
      getButton(host, "Save URL").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    await waitFor(() => {
      expect(storefrontUrlApi.updateStorefrontUrl).toHaveBeenCalledWith({
        data: { storefrontUrl: "https://new-shop.example.com" },
      });
    });

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.settings.storefrontUrl(),
    });
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.settings.seoDiscoveryLiveProbe(),
    });
  });
});
