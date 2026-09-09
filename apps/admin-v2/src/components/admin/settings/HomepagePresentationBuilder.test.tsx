// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HOMEPAGE_PRESENTATION,
  type HomepagePresentationConfig,
} from "@scalius/shared/homepage-presentation";
import { queryKeys } from "~/lib/query-keys";

const api = vi.hoisted(() => ({
  getHomepagePresentation: vi.fn(),
  saveHomepagePresentation: vi.fn(),
  getCategoryFormOptions: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("~/lib/api-functions/homepage-presentation", () => ({
  getHomepagePresentation: api.getHomepagePresentation,
  saveHomepagePresentation: api.saveHomepagePresentation,
}));
vi.mock("~/lib/api-functions/categories", () => ({
  getCategoryFormOptions: api.getCategoryFormOptions,
}));
vi.mock("sonner", () => ({ toast: { success: api.success, error: api.error } }));
vi.mock("../shared/SortableList", () => ({ SortableList: () => null }));
vi.mock("~/components/ui/searchable-select", () => ({ SearchableSelect: () => null }));

import { HomepagePresentationBuilder } from "./HomepagePresentationBuilder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function config(title: string): HomepagePresentationConfig {
  return {
    ...DEFAULT_HOMEPAGE_PRESENTATION,
    categoryRail: {
      ...DEFAULT_HOMEPAGE_PRESENTATION.categoryRail,
      enabled: true,
      title,
      categoryIds: ["category-a"],
    },
  };
}

describe("HomepagePresentationBuilder draft acknowledgement", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    api.getHomepagePresentation.mockReset();
    api.saveHomepagePresentation.mockReset();
    api.getCategoryFormOptions.mockReset().mockResolvedValue({ categories: [] });
    api.success.mockReset();
    api.error.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    host.remove();
  });

  async function flush() {
    for (let pass = 0; pass < 4; pass += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function renderBuilder(initialTitle = "Original") {
    api.getHomepagePresentation.mockResolvedValue({
      config: config(initialTitle),
      revision: 7,
    });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <HomepagePresentationBuilder />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  function heading() {
    return host.querySelector<HTMLInputElement>("#homepage-category-title")!;
  }

  function setHeading(value: string) {
    act(() => {
      const input = heading();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function button(label: string) {
    return [...host.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    ) as HTMLButtonElement | undefined;
  }

  it("canonicalizes the submitted title while preserving a newer toggle and revision", async () => {
    await renderBuilder();
    setHeading("  Submitted  ");
    const write = deferred<{ config: HomepagePresentationConfig; revision: number }>();
    api.saveHomepagePresentation.mockReturnValueOnce(write.promise);

    act(() => button("Save homepage")?.click());
    act(() => host.querySelector<HTMLButtonElement>("#homepage-trust-strip")?.click());
    write.resolve({ config: config("Submitted"), revision: 8 });
    await flush();

    expect(heading().value).toBe("Submitted");
    expect(host.querySelector<HTMLButtonElement>("#homepage-trust-strip")?.getAttribute("aria-checked")).toBe("true");
    expect(api.saveHomepagePresentation).toHaveBeenCalledWith({
      data: { ...config("  Submitted  "), expectedRevision: 7 },
    });

    api.saveHomepagePresentation.mockResolvedValueOnce({ config: config("Submitted"), revision: 9 });
    act(() => button("Save homepage")?.click());
    await flush();
    expect(api.saveHomepagePresentation).toHaveBeenLastCalledWith({
      data: { ...config("Submitted"), trustStrip: { enabled: true }, expectedRevision: 8 },
    });
  });

  it("keeps a failed draft visible and resets it to the last acknowledged value", async () => {
    await renderBuilder();
    setHeading("Submitted");
    const write = deferred<never>();
    api.saveHomepagePresentation.mockReturnValueOnce(write.promise);

    act(() => button("Save homepage")?.click());
    setHeading("Newer unsaved");
    write.reject(new Error("Save failed"));
    await flush();

    expect(heading().value).toBe("Newer unsaved");
    act(() => button("Reset")?.click());
    expect(heading().value).toBe("Original");
    expect(button("Save homepage")).toBeUndefined();
    expect(api.error).toHaveBeenCalledWith("Save failed");
  });

  it("ignores a stale read after acknowledgement and keeps a post-submit revert", async () => {
    await renderBuilder();
    setHeading("Submitted");
    const write = deferred<{ config: HomepagePresentationConfig; revision: number }>();
    api.saveHomepagePresentation.mockReturnValueOnce(write.promise);

    act(() => button("Save homepage")?.click());
    setHeading("Original");
    write.resolve({ config: config("Submitted"), revision: 8 });
    await flush();

    expect(heading().value).toBe("Original");
    queryClient.setQueryData(queryKeys.settings.homepagePresentation(), {
      config: config("Stale read"),
      revision: 7,
    });
    await flush();

    expect(heading().value).toBe("Original");
    expect(button("Reset")).toBeDefined();
  });

  it("does not hydrate a dirty draft from a background query update", async () => {
    await renderBuilder();
    setHeading("Newer unsaved");

    queryClient.setQueryData(queryKeys.settings.homepagePresentation(), {
      config: config("Background server value"),
      revision: 9,
    });
    await flush();

    expect(heading().value).toBe("Newer unsaved");
    act(() => button("Reset")?.click());
    expect(heading().value).toBe("Background server value");
  });
});
