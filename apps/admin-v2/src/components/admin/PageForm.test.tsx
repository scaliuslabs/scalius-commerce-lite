// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageForm } from "./PageForm";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { PageFormValues } from "~/lib/form-schemas";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const granted = vi.hoisted(() => new Set<string>());

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminPages: api.create,
  putApiV1AdminPagesById: api.update,
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
vi.mock("~/contexts/PermissionContext", () => ({
  usePermissions: () => ({ hasPermission: (permission: string) => granted.has(permission) }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

const inTwoDays = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
inTwoDays.setSeconds(0, 0);

const savedPost: Partial<PageFormValues> = {
  id: "page_size_guide",
  revision: 2,
  contentType: "article",
  title: "How to choose a panjabi size",
  slug: "panjabi-size-guide",
  content: "<p>Measure your chest.</p>",
  excerpt: "Find your size in two minutes.",
  author: "Rahim",
  tags: ["Guides"],
  metaTitle: null,
  metaDescription: null,
  canonicalPath: "/blog/panjabi-size-guide",
  noIndex: false,
  excludeFromSitemap: true,
  publicationMode: "scheduled",
  publishedAt: inTwoDays,
  hideHeader: false,
  hideFooter: false,
  hideTitle: false,
  featuredImage: null,
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

function queryButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label,
  );
}

function button(label: string): HTMLButtonElement {
  const match = queryButton(label);
  if (!match) throw new Error(`No button ${label}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

describe("PageForm", () => {
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    granted.clear();
    for (const permission of ["pages.create", "pages.edit", "pages.publish"]) granted.add(permission);
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.create.mockResolvedValue({ id: "page_new", revision: 1 });
    api.update.mockResolvedValue({ id: "page_size_guide", revision: 3 });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
  });

  async function render(props: Parameters<typeof PageForm>[0] = {}) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PageForm {...props} />
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  it("creates a draft page and leaves its web address to the server", async () => {
    await render();

    expect(document.querySelector("h1")?.textContent).toBe("Add page");
    expect(document.body.textContent).toContain("Customers can't see it yet.");
    type(byLabel("Title"), "About us");
    type(byLabel("Content"), "<p>We make panjabi in Dhaka.</p>");
    await settle();
    expect(document.body.textContent).toContain("https://shop.example/about-us");

    await click(button("Save"));

    expect(api.create.mock.calls[0]?.[0]?.body).not.toHaveProperty("slug", expect.anything());
    expect(api.create.mock.calls[0]?.[0]?.body).toEqual(
      expect.objectContaining({
        contentType: "page",
        title: "About us",
        isPublished: false,
        publishedAt: null,
        canonicalPath: null,
        excludeFromSitemap: false,
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Page created");
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/admin/pages/$pageId/edit", params: { pageId: "page_new" } }),
    );
  });

  it("keeps a scheduled blog post scheduled and moves its main address with the web address", async () => {
    await render({ contentType: "article", defaultValues: savedPost, isEdit: true });

    expect(document.body.textContent).toContain("Customers see it from the time you choose.");
    expect(byLabel<HTMLInputElement>("Publish on").value).not.toBe("");
    expect(document.body.textContent).toContain("Find your size in two minutes.");

    await click(button("Edit search engine listing"));
    type(byLabel("URL handle"), "panjabi-sizes");
    await settle();
    await click(button("Save"));

    expect(api.update.mock.calls[0]?.[0]).toEqual({
      path: { id: "page_size_guide" },
      body: expect.objectContaining({
        expectedRevision: 2,
        slug: "panjabi-sizes",
        canonicalPath: "/blog/panjabi-sizes",
        excludeFromSitemap: true,
        isPublished: true,
        publishedAt: inTwoDays.toISOString(),
        author: "Rahim",
        tags: ["Guides"],
      }),
    });
    expect(toastMock.success).toHaveBeenCalledWith("Blog post saved");
  });

  it("refuses a web address the store already uses", async () => {
    await render({ defaultValues: { ...savedPost, contentType: "page", excerpt: null, author: null, tags: [], canonicalPath: null }, isEdit: true });

    await click(button("Edit search engine listing"));
    type(byLabel("URL handle"), "checkout");
    await settle();

    expect(document.body.textContent).toContain("This web address is used by the store. Try another.");
    await click(button("Save"));
    expect(api.update).not.toHaveBeenCalled();
  });

  it("tells the merchant to reload when the page changed elsewhere", async () => {
    api.update.mockRejectedValue(new AdminApiResponseError("changed", 409, "PAGE_REVISION_CONFLICT"));
    await render({ contentType: "article", defaultValues: savedPost, isEdit: true });

    type(byLabel("Title"), "Panjabi size guide");
    await settle();
    await click(button("Save"));

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "This was changed somewhere else. Reload the page to see the latest version.",
    );
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("locks visibility without publish permission", async () => {
    granted.delete("pages.publish");
    await render({ contentType: "article", defaultValues: savedPost, isEdit: true });

    expect(document.body.textContent).toContain("Only staff who can publish can change this.");
    expect(byLabel<HTMLButtonElement>("Visibility").disabled).toBe(true);
    expect(byLabel<HTMLInputElement>("Publish on").disabled).toBe(true);
    expect(byLabel<HTMLInputElement>("Title").disabled).toBe(false);
  });

  it("shows a read-only editor without edit permission", async () => {
    granted.delete("pages.edit");
    await render({ contentType: "article", defaultValues: savedPost, isEdit: true });

    expect(document.body.textContent).toContain("You can view this but not change it.");
    expect(document.querySelector("fieldset")?.disabled).toBe(true);
    expect(queryButton("Save")).toBeUndefined();
    expect(document.body.textContent).toContain("Measure your chest.");
  });
});
