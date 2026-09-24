// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CategoryForm } from "./CategoryForm";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { CategoryFormValues } from "~/lib/form-schemas";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const permissions = vi.hoisted(() => ({ canCreate: true, canEdit: true }));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminCategories: api.create,
  putApiV1AdminCategoriesById: api.update,
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("~/components/admin/shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("~/components/ui/tiptap/DeferredTiptapEditor", () => ({
  DeferredTiptapEditor: ({ content, onChange, ariaLabel }: {
    content: string;
    onChange: (value: string) => void;
    ariaLabel: string;
  }) => <textarea aria-label={ariaLabel} value={content} onChange={(event) => onChange(event.target.value)} />,
}));
vi.mock("~/components/admin/shared/FormImageUploadField", () => ({ FormImageUploadField: () => null }));
vi.mock("~/hooks/use-storefront-url", () => ({
  useStorefrontUrl: () => ({
    storefrontUrl: "https://shop.example",
    getStorefrontPath: (path: string) => `https://shop.example${path}`,
  }),
}));
vi.mock("~/hooks/use-catalog-action-permissions", () => ({
  useCatalogActionPermissions: () => ({ categories: permissions }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

const saved: Partial<CategoryFormValues> = {
  id: "cat_panjabi",
  revision: 4,
  status: "draft",
  name: "Panjabi",
  description: "<p>Cotton and silk panjabi.</p>",
  content: null,
  slug: "panjabi",
  metaTitle: null,
  metaDescription: null,
  canonicalPath: "/categories/panjabi",
  noIndex: false,
  excludeFromSitemap: true,
  image: null,
};

const notReady = {
  ready: false,
  eligibleProductCount: 0,
  blockers: [{ code: "no_buyer_resolvable_products" as const, message: "server copy" }],
  warnings: [],
};

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function byLabel<T extends HTMLElement>(label: string): T {
  const labelled = document.querySelector<T>(`[aria-label="${label}"]`);
  if (labelled) return labelled;
  const forLabel = Array.from(document.querySelectorAll("label")).find((node) => node.textContent?.trim() === label);
  const control = forLabel?.htmlFor ? document.getElementById(forLabel.htmlFor) : null;
  if (!control) throw new Error(`No control labelled ${label}`);
  return control as T;
}

function queryButton(label: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label,
  );
}

function button(label: string, scope?: ParentNode): HTMLButtonElement {
  const match = queryButton(label, scope);
  if (!match) throw new Error(`No button ${label}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

describe("CategoryForm", () => {
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    permissions.canCreate = true;
    permissions.canEdit = true;
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.create.mockResolvedValue({ id: "cat_new", revision: 1, status: "draft" });
    api.update.mockResolvedValue({ id: "cat_panjabi", revision: 5, status: "draft" });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
  });

  async function render(props: Parameters<typeof CategoryForm>[0] = {}) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CategoryForm {...props} />
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  it("creates a draft category with a web address taken from the name", async () => {
    await render();

    expect(document.querySelector("h1")?.textContent).toBe("Add category");
    expect(document.body.textContent).toContain("Customers can't see it yet. Make it active when it's ready.");
    type(byLabel("Name"), "Eid Panjabi 2026");
    await settle();
    expect(document.body.textContent).toContain("https://shop.example/categories/eid-panjabi-2026");
    expect(document.querySelector("[data-save-bar]")?.textContent).toContain("Unsaved category");

    await click(button("Save"));

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create.mock.calls[0]?.[0]?.body).toEqual(
      expect.objectContaining({
        name: "Eid Panjabi 2026",
        slug: "eid-panjabi-2026",
        status: "draft",
        canonicalPath: null,
        noIndex: false,
        excludeFromSitemap: false,
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Category saved");
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/admin/categories/$categoryId/edit", params: { categoryId: "cat_new" } }),
    );
  });

  it("saves search listing edits with the revision and keeps hidden discovery settings", async () => {
    await render({ defaultValues: saved, isEdit: true, publishReadiness: { ...notReady, ready: true, blockers: [] } });

    expect(document.body.textContent).toContain("Cotton and silk panjabi.");
    await click(button("Edit search engine listing"));
    type(byLabel("Page title"), "Panjabi for Eid");
    type(byLabel("URL handle"), "eid-panjabi");
    await settle();
    await click(button("Save"));

    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0]?.[0]).toEqual({
      path: { id: "cat_panjabi" },
      body: expect.objectContaining({
        expectedRevision: 4,
        status: "draft",
        metaTitle: "Panjabi for Eid",
        slug: "eid-panjabi",
        canonicalPath: "/categories/eid-panjabi",
        noIndex: false,
        excludeFromSitemap: true,
      }),
    });
    expect(toastMock.success).toHaveBeenCalledWith("Category saved");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows the save bar for edits and discards them back to the saved category", async () => {
    await render({ defaultValues: saved, isEdit: true });
    expect(document.querySelector("[data-save-bar]")).toBeNull();
    expect(button("Save").disabled).toBe(true);

    type(byLabel("Name"), "Panjabi and kurta");
    await settle();
    const bar = document.querySelector<HTMLElement>("[data-save-bar]");
    expect(bar?.textContent).toContain("Unsaved changes");
    await click(button("Discard", bar!));
    await click(button("Discard changes"));

    expect(byLabel<HTMLInputElement>("Name").value).toBe("Panjabi");
    expect(document.querySelector("[data-save-bar]")).toBeNull();
    expect(api.update).not.toHaveBeenCalled();
  });

  it("explains a bad web address and does not save it", async () => {
    await render({ defaultValues: saved, isEdit: true });

    await click(button("Edit search engine listing"));
    type(byLabel("URL handle"), "Eid Panjabi!");
    await settle();

    expect(document.body.textContent).toContain("Use lowercase letters, numbers and dashes, e.g. summer-sale.");
    await click(button("Save"));
    expect(api.update).not.toHaveBeenCalled();
  });

  it("puts a taken web address on the field", async () => {
    api.update.mockRejectedValue(new Error("A category with this slug already exists."));
    await render({ defaultValues: saved, isEdit: true });

    type(byLabel("Name"), "Panjabi and kurta");
    await settle();
    await click(button("Save"));

    expect(byLabel("URL handle").getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("This web address is taken. Try another.");
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("tells the merchant to reload when the category changed elsewhere", async () => {
    api.update.mockRejectedValue(
      new AdminApiResponseError("conflict", 409, "CATEGORY_REVISION_CONFLICT", {
        expectedRevision: 4,
        currentRevision: 5,
      }),
    );
    await render({ defaultValues: saved, isEdit: true });

    type(byLabel("Name"), "Panjabi and kurta");
    await settle();
    await click(button("Save"));

    expect(api.update.mock.calls[0]?.[0]?.body.expectedRevision).toBe(4);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "This category was changed somewhere else. Reload the page to see the latest version.",
    );
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  async function chooseStatus(label: string) {
    const status = byLabel<HTMLButtonElement>("Status");
    await act(async () => {
      status.focus();
      status.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (candidate) => candidate.textContent === label,
    );
    if (!option) throw new Error(`No status ${label}`);
    await click(option);
  }

  it("creates an active category and warns that it stays empty until products are added", async () => {
    api.create.mockResolvedValue({ id: "cat_new", revision: 1, status: "published" });
    await render();

    type(byLabel("Name"), "Eid sale");
    await settle();
    await chooseStatus("Active");

    expect(document.body.textContent).toContain("Customers can browse it on your store.");
    expect(document.body.textContent).toContain("It stays empty on your store until you add active products.");
    await click(button("Save"));
    expect(api.create.mock.calls[0]?.[0]?.body).toEqual(expect.objectContaining({ status: "published", slug: "eid-sale" }));
  });

  it("explains each status and warns only when an active category has no active products", async () => {
    await render({ defaultValues: saved, isEdit: true, publishReadiness: notReady });

    await chooseStatus("Hidden");
    expect(document.body.textContent).toContain("Customers can't see it. Use it to organize products.");
    await chooseStatus("Active");
    expect(document.body.textContent).toContain("It stays empty on your store until you add active products.");
    await click(button("Save"));
    expect(api.update.mock.calls[0]?.[0]?.body).toEqual(expect.objectContaining({ status: "published", expectedRevision: 4 }));
  });

  it("shows a read-only editor without edit permission", async () => {
    permissions.canEdit = false;
    await render({ defaultValues: saved, isEdit: true });

    expect(document.body.textContent).toContain("You can view this but not change it.");
    expect(document.querySelector("fieldset")?.disabled).toBe(true);
    expect(queryButton("Save")).toBeUndefined();
    expect(document.querySelector('textarea[aria-label="Description"]')).toBeNull();
  });
});
