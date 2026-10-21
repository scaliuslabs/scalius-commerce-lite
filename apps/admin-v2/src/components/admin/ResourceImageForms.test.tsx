// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandForm } from "./BrandForm";
import { CategoryForm } from "./CategoryForm";
import type { MediaFile } from "./media-manager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  putApiV1AdminBrandsById: api.update,
  putApiV1AdminCategoriesById: api.update,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/components/admin/shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("~/components/ui/tiptap/DeferredTiptapEditor", () => ({ DeferredTiptapEditor: () => null }));
vi.mock("~/hooks/use-storefront-url", () => ({
  useStorefrontUrl: () => ({ storefrontUrl: "https://shop.example", getStorefrontPath: (path: string) => `https://shop.example${path}` }),
}));
vi.mock("~/hooks/use-catalog-action-permissions", () => ({
  useCatalogActionPermissions: () => ({ categories: { canCreate: true, canEdit: true } }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("./media-manager", () => ({
  MediaManager: ({ onSelect }: { onSelect: (file: MediaFile) => void }) => (
    <>
      <button type="button" onClick={() => onSelect(original)}>Pick original</button>
      <button type="button" onClick={() => onSelect(other)}>Pick other</button>
    </>
  ),
}));

const original: MediaFile = {
  id: "media_original", url: "https://media.example/original.jpg", filename: "original.jpg",
  size: 32000, createdAt: new Date("2026-01-01"), width: 640, height: 480, altText: "Original image metadata",
};
const other: MediaFile = { ...original, id: "media_other", url: "https://media.example/other.jpg", filename: "other.jpg", altText: "Other image metadata" };
const common = {
  id: "resource_one", revision: 4, status: "draft" as const, name: "Original name", slug: "original-name",
  description: null, metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false, excludeFromSitemap: false,
};

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}
async function click(label: string) {
  const target = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label);
  if (!target) throw new Error(`No button ${label}`);
  await act(async () => target.click());
  await settle();
}
function dirty() { return document.querySelector("[data-save-bar]") !== null; }

describe.each(["brand", "category"] as const)("%s image identity", (resource) => {
  let root: Root;
  let queryClient: QueryClient;
  const placeholder = { ...original, id: resource === "category" ? "temp_resource_one" : original.id, size: 0, createdAt: new Date(0), altText: null };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Each form reads its own resource from the write's answer.
    api.update.mockResolvedValue({ brand: { revision: 5, status: "draft" }, category: { revision: 5, status: "draft" } });
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        {resource === "brand"
          ? <BrandForm defaultValues={{ ...common, logo: placeholder, sortOrder: 0 }} />
          : <CategoryForm defaultValues={{ ...common, image: placeholder, content: null }} isEdit />}
      </QueryClientProvider>,
    ));
    await settle();
  });
  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
  });

  it("keeps a same-image selection clean with full preview metadata and the saved payload", async () => {
    expect(dirty()).toBe(false);
    await click("Pick original");
    expect(dirty()).toBe(false);
    expect(document.querySelector("img")?.alt).toBe(original.altText);
    await click("Remove original.jpg");
    expect(dirty()).toBe(true);
    await click("Pick original");
    expect(dirty()).toBe(false);
    await click("Pick other");
    expect(dirty()).toBe(true);
    await click("Pick original");
    expect(dirty()).toBe(false);

    const name = document.querySelector<HTMLInputElement>('input[name="name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "New name");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    await click("Save");
    const body = api.update.mock.calls[0]?.[0]?.body;
    expect(body).toMatchObject(resource === "brand"
      ? { logoMediaId: original.id }
      : { image: { id: placeholder.id, url: placeholder.url, filename: placeholder.filename, size: 0, createdAt: placeholder.createdAt.toISOString() } });
    expect(dirty()).toBe(false);
  });

  it("uses the acknowledged image as the new baseline for revert and discard", async () => {
    await click("Pick other");
    expect(dirty()).toBe(true);
    await click("Save");
    expect(api.update.mock.calls[0]?.[0]?.body).toMatchObject(resource === "brand" ? { logoMediaId: other.id } : { image: { url: other.url } });
    expect(dirty()).toBe(false);
    await click("Pick original");
    expect(dirty()).toBe(true);
    await click("Pick other");
    expect(dirty()).toBe(false);
    await click("Pick original");
    await click("Discard");
    await click("Discard changes");
    expect(dirty()).toBe(false);
    expect(document.querySelector("img")?.alt).toBe(other.altText);
  });
});
