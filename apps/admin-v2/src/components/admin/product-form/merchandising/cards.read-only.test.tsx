// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductPageCard from "./ProductPageCard";
import BundlesCard from "./BundlesCard";
import ContentBlocksCard from "./ContentBlocksCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const sections = vi.hoisted(() => new Map<string, { dirty: boolean; navigationDirty?: boolean; problems: unknown; changes: () => unknown }>());
vi.mock("./product-sections", () => ({ useProductSection: (section: { label: string; dirty: boolean; navigationDirty?: boolean; problems: unknown; changes: () => unknown }) => sections.set(section.label, section) }));
vi.mock("./section-api", () => ({
  productBaseSectionQueryOptions: () => ({ queryKey: ["base"], staleTime: Infinity }),
  productBundlesQueryOptions: () => ({ queryKey: ["bundles"], staleTime: Infinity }),
  productContentBlocksQueryOptions: () => ({ queryKey: ["blocks"], staleTime: Infinity }),
}));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ code: "BDT", fmt: (value: number) => `৳${value}` }) }));
vi.mock("~/components/admin/media-manager", () => ({ MediaManager: () => <button type="button">Choose media</button> }));
vi.mock("~/components/ui/tiptap/DeferredTiptapEditor", () => ({ DeferredTiptapEditor: () => <div contentEditable data-editor="true" /> }));

describe("readable advanced product cards", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    sections.clear();
  });
  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    host.remove();
  });
  async function render(content: React.ReactNode) {
    await act(async () => { root.render(<QueryClientProvider client={queryClient}>{content}</QueryClientProvider>); });
  }
  async function refresh(key: string, value: unknown) {
    await act(async () => {
      queryClient.setQueryData([key], value);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("uses authoritative refreshed page facts while keeping a revoked editor's draft unsaved", async () => {
    queryClient.setQueryData(["base"], { product: { pageTemplate: "classic", emiEligible: false } });
    await render(<ProductPageCard productId="product" readOnly={false} />);
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await render(<ProductPageCard productId="product" readOnly />);
    expect(host.querySelector("button, input")).toBeNull();
    expect([...sections.values()].some((section) => section.navigationDirty)).toBe(true);
    expect(host.textContent).toContain("No");
    await refresh("base", { product: { pageTemplate: "external-theme", emiEligible: true } });
    expect(host.textContent).toContain("external-theme (no longer offered)");
    expect(host.textContent).toContain("Yes");
    expect([...sections.values()].every((section) => !section.dirty && section.problems === null)).toBe(true);
    expect([...sections.values()].map((section) => section.changes())).toEqual([{}]);
  });

  it("keeps bundle browsing usable with readable quantity, price and state", async () => {
    queryClient.setQueryData(["bundles"], { items: [{ id: "tier", quantity: 3, discountType: "fixed_price", discountPercentage: null, price: 900, label: "Family pack", isActive: false }] });
    await render(<BundlesCard productId="product" readOnly />);
    expect(host.textContent).toContain("Family pack");
    expect(host.textContent).toContain("৳900");
    expect(host.textContent).toContain("Inactive");
    expect(host.querySelector("input, textarea, [role=switch], [role=combobox]")).toBeNull();
    const disclosure = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(disclosure.disabled).toBe(false);
    await act(async () => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens saved content for reading without mounting its editor", async () => {
    queryClient.setQueryData(["blocks"], { media: [], items: [{ id: "care", type: "rich-text", version: 1, placement: "tabs", legacy: false, settings: { title: "Care", html: "<p>Dry in shade.</p>" } }] });
    await render(<ContentBlocksCard productId="product" readOnly onTabsMoved={vi.fn()} />);
    const view = host.querySelector<HTMLButtonElement>('button[aria-label="View Care"]')!;
    expect(view.disabled).toBe(false);
    await act(async () => view.click());
    expect(host.textContent).toContain("Dry in shade.");
    expect(host.querySelector("input, textarea, [contenteditable], [role=combobox]")).toBeNull();
    expect([...host.querySelectorAll("button")].every((button) => button.hasAttribute("aria-expanded"))).toBe(true);
  });
});
