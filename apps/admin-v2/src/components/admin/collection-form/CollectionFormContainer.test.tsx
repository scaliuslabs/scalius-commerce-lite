// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollectionForm } from "./CollectionFormContainer";
import type { Category, CollectionFormValues, Product } from "./types";
import { queryKeys } from "~/lib/query-keys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
  getCollectionProductOptions: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const permissionMock = vi.hoisted(() => ({ canCreate: true, canEdit: true }));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminCollections: api.createCollection,
  putApiV1AdminCollectionsById: api.updateCollection,
  getApiV1AdminCollectionsProductOptions: api.getCollectionProductOptions,
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("~/hooks/use-storefront-url", () => ({
  useStorefrontUrl: () => ({ storefrontUrl: "https://shop.test" }),
}));
vi.mock("~/components/admin/shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: (value: number) => `৳${value}` }) }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("~/hooks/use-catalog-action-permissions", () => ({
  useCatalogActionPermissions: () => ({ collections: permissionMock }),
}));

const categories: Category[] = [
  { id: "cat_curated", name: "Curated Picks", status: "published" },
  { id: "cat_draft", name: "Winter drafts", status: "draft" },
];

const savedCollection: Partial<CollectionFormValues> = {
  id: "col_eid",
  version: 7,
  name: "Eid collection",
  presentation: "grid",
  isActive: true,
  canonicalPath: "/collections/col_eid",
  noIndex: false,
  excludeFromSitemap: true,
  metaTitle: null,
  metaDescription: null,
  config: {
    source: "manual",
    categoryIds: [],
    productIds: ["prod_panjabi", "prod_sari"],
    featuredProductId: "prod_featured",
    showOnHomepage: true,
    maxProducts: 8,
    title: "Eid picks",
    subtitle: "",
  },
};

const productLabels: Product[] = [
  { id: "prod_panjabi", name: "Cotton panjabi" },
  { id: "prod_sari", name: "Jamdani sari", isActive: false },
  { id: "prod_featured", name: "Silk scarf" },
];

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

function text(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function button(label: string, scope: ParentNode = document.body): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => text(candidate.textContent) === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Expected a button labeled ${label}`);
  return found;
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelElement = Array.from(document.body.querySelectorAll("label")).find(
    (candidate) => text(candidate.textContent) === label,
  );
  const control = labelElement?.htmlFor ? document.getElementById(labelElement.htmlFor) : null;
  if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
    throw new Error(`Expected a field labeled ${label}`);
  }
  return control;
}

async function type(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function choose(selectLabel: string, option: string) {
  const select = Array.from(document.body.querySelectorAll<HTMLSelectElement>("select")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === selectLabel
      || text(candidate.selectedOptions[0]?.textContent) === selectLabel,
  );
  if (!select) throw new Error(`Expected a select labeled ${selectLabel}`);
  const item = Array.from(select.options).find((candidate) => text(candidate.textContent) === option);
  if (!item) throw new Error(`Expected option ${option}`);
  await act(async () => {
    select.value = item.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("CollectionForm", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionMock.canCreate = true;
    permissionMock.canEdit = true;
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    api.createCollection.mockResolvedValue({ id: "col_new", version: 1 });
    api.updateCollection.mockResolvedValue({ id: "col_eid", version: 8 });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
  });

  async function render(props: Partial<Parameters<typeof CollectionForm>[0]> = {}) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CollectionForm categories={categories} {...props} />
        </QueryClientProvider>,
      );
    });
  }

  const renderSaved = (products: Product[] = productLabels) =>
    render({ products, defaultValues: savedCollection, isEdit: true });

  function lastUpdateBody() {
    return api.updateCollection.mock.calls.at(-1)?.[0]?.body;
  }

  it("creates an inactive collection and opens it for editing", async () => {
    await render();
    expect(document.querySelector("h1")?.textContent).toBe("Add collection");

    await type(field("Title"), "Summer sale");
    await click(button("Save"));

    await waitFor(() => expect(api.createCollection).toHaveBeenCalledTimes(1));
    expect(api.createCollection.mock.calls[0]?.[0]?.body).toMatchObject({
      name: "Summer sale",
      isActive: false,
      noIndex: false,
      config: { source: "manual", productIds: [], categoryIds: [] },
    });
    expect(api.updateCollection).not.toHaveBeenCalled();
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Collection saved"));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      to: "/admin/collections/$collectionId/edit",
      params: { collectionId: "col_new" },
    }));
  });

  it("saves edits with the expected version and keeps the product order", async () => {
    await renderSaved([]);
    expect(host.textContent).not.toContain("prod_panjabi");

    await renderSaved();
    await waitFor(() => expect(host.textContent).toContain("Jamdani sari"));
    expect(host.textContent).toContain("Silk scarf");

    await click(button("Move Jamdani sari up"));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await click(button("Save"));

    await waitFor(() => expect(api.updateCollection).toHaveBeenCalledTimes(1));
    expect(api.updateCollection.mock.calls[0]?.[0]?.path).toEqual({ id: "col_eid" });
    expect(lastUpdateBody()).toMatchObject({
      expectedVersion: 7,
      canonicalPath: "/collections/col_eid",
      excludeFromSitemap: true,
      config: {
        source: "manual",
        productIds: ["prod_sari", "prod_panjabi"],
        featuredProductId: "prod_featured",
        showOnHomepage: true,
      },
    });
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Collection saved"));
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      queryKeys.collections.list(),
      queryKeys.collections.byIds(),
      queryKeys.collections.formOptions(),
      queryKeys.collections.detail("col_eid"),
    ]);
    expect(navigate).not.toHaveBeenCalled();

    // The next save sends the version the server returned.
    await click(button("Move Jamdani sari down"));
    await click(button("Save"));
    await waitFor(() => expect(api.updateCollection).toHaveBeenCalledTimes(2));
    expect(lastUpdateBody().expectedVersion).toBe(8);
  });

  it("is read-only without edit permission", async () => {
    permissionMock.canEdit = false;
    await renderSaved();

    expect(host.textContent).toContain("You can view this but not change it.");
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(() => button("Save")).toThrow();
  });

  it("adds picked products after the ones already in the collection", async () => {
    api.getCollectionProductOptions.mockResolvedValue({
      products: [
        { id: "prod_panjabi", name: "Cotton panjabi", price: 1500, categoryId: null, categoryName: null, isActive: true, primaryImage: null },
        { id: "prod_tote", name: "Canvas tote", price: 800, categoryId: "cat_curated", categoryName: "Curated Picks", isActive: true, primaryImage: "/p/tote.webp" },
        { id: "prod_shawl", name: "Wool shawl", price: 2200, categoryId: "cat_curated", categoryName: "Curated Picks", isActive: false, primaryImage: null },
      ],
      pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
    });
    await renderSaved();

    await click(button("Add products"));
    await waitFor(() => expect(document.body.textContent).toContain("Canvas tote"));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const box = (name: string) => dialog.querySelector<HTMLButtonElement>(`button[role="checkbox"][aria-label="${name}"]`)!;
    expect(box("Cotton panjabi").disabled).toBe(true);
    await click(box("Wool shawl"));
    await click(box("Canvas tote"));
    expect(dialog.textContent).toContain("2 selected");
    await click(button("Add", dialog));

    expect(host.textContent).toContain("Canvas tote");
    await click(button("Save"));
    await waitFor(() => expect(api.updateCollection).toHaveBeenCalledTimes(1));
    expect(lastUpdateBody().config.productIds).toEqual(["prod_panjabi", "prod_sari", "prod_shawl", "prod_tote"]);
  });

  it("sends search engine listing edits with the collection", async () => {
    await renderSaved();
    expect(host.textContent).toContain("https://shop.test/collections/col_eid");
    expect(host.textContent).toContain("Eid collection");

    await click(button("Edit search engine listing"));
    await type(field("Page title"), "Eid panjabi and sari");
    await type(field("Meta description"), "Festive picks, delivered across Bangladesh.");
    const hide = Array.from(host.querySelectorAll("label")).find((label) =>
      text(label.textContent).startsWith("Hide from search engines"),
    )?.querySelector<HTMLButtonElement>('button[role="checkbox"]');
    if (!hide) throw new Error("Expected the hide checkbox");
    await click(hide);
    expect(host.textContent).toContain("Hidden from search engines.");

    await click(button("Save"));
    await waitFor(() => expect(api.updateCollection).toHaveBeenCalledTimes(1));
    expect(lastUpdateBody()).toMatchObject({
      metaTitle: "Eid panjabi and sari",
      metaDescription: "Festive picks, delivered across Bangladesh.",
      noIndex: true,
      canonicalPath: "/collections/col_eid",
      excludeFromSitemap: true,
    });
  });

  it("blocks an active collection that has nothing in it", async () => {
    await render({ defaultValues: { name: "Draft collection" } });

    await choose("Status", "Active");
    await click(button("Save"));
    await waitFor(() => expect(host.textContent).toContain("Add a product, or keep the collection as a draft."));

    await click(host.querySelector<HTMLButtonElement>('button[role="radio"][value="dynamic"]')!);
    await waitFor(() => {
      expect(host.textContent).not.toContain("Add a product, or keep the collection as a draft.");
      expect(host.textContent).toContain("Choose a category, or keep the collection as a draft.");
    });
    expect(api.createCollection).not.toHaveBeenCalled();
  });

  it("won't activate an automatic collection built on unpublished categories", async () => {
    await render({
      defaultValues: {
        name: "Winter",
        isActive: true,
        config: { ...savedCollection.config!, source: "dynamic", categoryIds: ["cat_draft"], productIds: [] },
      },
    });
    expect(host.textContent).toContain("Winter drafts");
    expect(host.textContent).toContain("Make these categories active before you make the collection active.");

    await type(field("Title"), "Winter coats");
    await click(button("Save"));
    await waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        "Make these categories active before you make the collection active.",
      ),
    );
    expect(api.createCollection).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("explains that automatic collections need an active category", async () => {
    await render({ categories: [{ id: "cat_draft", name: "Winter drafts", status: "draft" }], defaultValues: { name: "Winter" } });

    await click(host.querySelector<HTMLButtonElement>('button[role="radio"][value="dynamic"]')!);

    await waitFor(() => expect(host.textContent).toContain("Only active categories can be used. Make a category active first."));
    expect(host.querySelector('a[href="/admin/categories"]')?.textContent).toBe("Go to categories");
    expect(host.querySelector('button[aria-label="Add a category"]')).toBeNull();
  });

  it("previews the products an automatic collection will contain", async () => {
    api.getCollectionProductOptions.mockResolvedValue({
      products: [
        { id: "prod_panjabi", name: "Cotton panjabi", price: 2500, categoryId: "cat_curated", categoryName: "Curated Picks", isActive: true, primaryImage: null, variantCount: 2, available: 7 },
        { id: "prod_tupi", name: "Tupi", price: 250, categoryId: "cat_curated", categoryName: "Curated Picks", isActive: false, primaryImage: null, variantCount: 0, available: 0 },
      ],
      pagination: { page: 1, limit: 10, total: 2, totalPages: 1 },
    });
    await render({
      defaultValues: {
        name: "Curated",
        config: { ...savedCollection.config!, source: "dynamic", categoryIds: ["cat_curated", "cat_draft"], productIds: [] },
      },
    });

    await waitFor(() => expect(host.textContent).toContain("Cotton panjabi"));
    const preview = host.querySelector('section[aria-label="Products in this collection"]');
    expect(text(preview?.textContent)).toContain("Products in this collection2 products");
    expect(text(preview?.textContent)).toContain("৳2500 · 2 variants · 7 in stock");
    expect(text(preview?.textContent)).toContain("Tupi৳250 · Out of stockDraft");
    // Only the active category counts: a draft category adds nothing on the store.
    expect(api.getCollectionProductOptions).toHaveBeenCalledWith({
      query: expect.objectContaining({ categoryIds: "cat_curated", limit: 10 }),
    });
    expect(host.textContent).toContain("2 categories (max 90)");
  });

  it("shows homepage options once the collection is on the homepage", async () => {
    await render({ defaultValues: { name: "Gifts" } });
    expect(host.textContent).not.toContain("Products shown");

    await click(host.querySelector<HTMLButtonElement>('button[role="switch"]')!);
    await waitFor(() => expect(host.textContent).toContain("Products shown"));
    expect(host.textContent).toContain("Appears once the collection is active.");
    expect(field("Heading").placeholder).toBe("Gifts");
    expect(host.textContent).toContain("Featured product");

    await choose("Grid", "Carousel");
    await waitFor(() => expect(host.textContent).not.toContain("Featured product"));
  });
});
