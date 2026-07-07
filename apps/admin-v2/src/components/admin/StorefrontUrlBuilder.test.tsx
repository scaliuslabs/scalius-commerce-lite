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

  it("explains that SEO proof needs a full absolute Store URL", async () => {
    await renderBuilder();

    expect(host.textContent).toContain(
      "SEO discovery proof needs a full absolute http(s) Store URL",
    );
    expect(host.textContent).toContain(
      'Path-only values such as "/" or "/store" only help dashboard preview/sidebar navigation',
    );
    expect(host.textContent).toContain('"View Store" link');
  });

  it("invalidates the SEO live proof after saving the Store URL", async () => {
    await renderBuilder();

    await act(async () => {
      getButton(host, "Save URL").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    await waitFor(() => {
      expect(storefrontUrlApi.updateStorefrontUrl).toHaveBeenCalledWith({
        data: { storefrontUrl: "https://shop.example.com" },
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
