// @vitest-environment happy-dom
import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { BrandForm } from "./BrandForm";
import type { BrandFormInput } from "~/lib/brand-form-schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const permissions = vi.hoisted(() => ({ canCreate: true, canEdit: true }));
const update = vi.hoisted(() => vi.fn());
vi.mock("~/hooks/use-catalog-action-permissions", () => ({ useCatalogActionPermissions: () => ({ categories: permissions }) }));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({ postApiV1AdminBrands: vi.fn(), putApiV1AdminBrandsById: update }));
vi.mock("~/components/admin/shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("~/components/admin/shared/FormImageUploadField", () => ({ FormImageUploadField: () => null }));
vi.mock("~/components/ui/tiptap/DeferredTiptapEditor", () => ({ DeferredTiptapEditor: ({ content, onChange, ariaLabel }: { content: string; onChange: (value: string) => void; ariaLabel: string }) => <textarea aria-label={ariaLabel} value={content} onChange={(event) => onChange(event.target.value)} /> }));
vi.mock("~/hooks/use-storefront-url", () => ({ useStorefrontUrl: () => ({ storefrontUrl: "https://store.example", getStorefrontPath: (path: string) => `https://store.example${path}` }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a> }));

it("replaces a dirty brand editor with committed facts and keeps the storefront link usable", async () => {
  const saved: BrandFormInput = { id: "brand_test", revision: 3, name: "Saved brand", slug: "saved-brand", description: "<p>Our saved story.</p>", status: "published", logo: null, sortOrder: 12, metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false, excludeFromSitemap: false };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = async () => { await act(async () => root.render(<QueryClientProvider client={queryClient}><BrandForm defaultValues={saved} /></QueryClientProvider>)); };
  try {
    await render();
    const input = host.querySelector<HTMLInputElement>('input[maxlength="120"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Unsaved brand");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    permissions.canEdit = false;
    await render();
    expect(host.querySelector("input, textarea, [role=combobox]")).toBeNull();
    expect(host.textContent).toContain("Saved brand");
    expect(host.textContent).toContain("Our saved story.");
    expect(host.textContent).not.toContain("Unsaved brand");
    expect(host.querySelector('a[href="https://store.example/brands/saved-brand"]')).not.toBeNull();
    expect(update).not.toHaveBeenCalled();
    permissions.canEdit = true;
    await render();
    expect(host.querySelector<HTMLInputElement>('input[maxlength="120"]')!.value).toBe("Unsaved brand");
  } finally {
    permissions.canEdit = true;
    act(() => root.unmount());
    queryClient.clear();
    host.remove();
  }
});
