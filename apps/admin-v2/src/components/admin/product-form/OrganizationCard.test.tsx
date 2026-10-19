// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Form } from "~/components/ui/form";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { OrganizationCard } from "./OrganizationCard";
import type { Category, ProductFormValues } from "./types";

const api = vi.hoisted(() => ({ create: vi.fn(), success: vi.fn(), error: vi.fn(), brand: vi.fn() }));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({ postApiV1AdminCategories: api.create }));
vi.mock("sonner", () => ({ toast: { success: api.success, error: api.error } }));
vi.mock("./BrandPicker", () => ({ default: () => { api.brand(); return null; } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const categories: Category[] = [
  { id: "cat_parent", name: "Clothing", status: "published" },
  { id: "cat_1", parentId: "cat_parent", name: "Kurta", status: "internal" },
];

function Harness({ readOnly = false, categoryId = "", brandId = null, brandName = null }: {
  readOnly?: boolean;
  categoryId?: string;
  brandId?: string | null;
  brandName?: string | null;
}) {
  const form = useForm<ProductFormValues>({ defaultValues: { categoryId, brandId } });
  return (
    <Form {...form}>
      <OrganizationCard form={form} categories={categories} brandName={brandName} readOnly={readOnly} />
    </Form>
  );
}

describe("OrganizationCard category create", () => {
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    client = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    document.body.innerHTML = "";
  });

  async function settle() {
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  async function openAndSearch(text: string) {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    ));
    await act(async () => (document.querySelector('[role="combobox"]') as HTMLButtonElement).click());
    // The list loads after the page: wait for it instead of assuming it drew with the popover.
    await vi.waitFor(() => expect(document.querySelector("[cmdk-input]")).not.toBeNull());
    const input = document.querySelector("[cmdk-input]") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  }
  const createButton = () =>
    Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.includes("Create"))!;

  it("reads the saved category path and refreshed brand prop without mounting either picker", async () => {
    await act(async () => root.render(<Harness readOnly categoryId="cat_1" brandId="brd_1" brandName="Acme" />));
    expect(document.body.textContent).toContain(`Clothing › Kurta · ${translate(productMessages, "categoryHidden")}`);
    expect(document.body.textContent).toContain("Acme");
    await act(async () => root.render(<Harness readOnly categoryId="cat_1" brandId="brd_1" brandName="Acme refreshed" />));
    expect(document.body.textContent).toContain("Acme refreshed");
    expect(document.querySelector("input, [role=combobox], button")).toBeNull();
    expect(api.brand).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("distinguishes empty references from saved references that cannot be resolved", async () => {
    await act(async () => root.render(<Harness readOnly brandName="Stale brand" />));
    expect(document.querySelectorAll('[data-slot="field-control"]')).toHaveLength(2);
    expect([...document.querySelectorAll('[data-slot="field-control"]')].map((node) => node.textContent)).toEqual(["—", "—"]);
    expect(document.body.textContent).not.toContain("Stale brand");
    await act(async () => root.render(<Harness key="unresolved" readOnly categoryId="cat_missing" brandId="brd_missing" />));
    const unavailable = translate(productMessages, "savedValueUnavailable");
    expect([...document.querySelectorAll('[data-slot="field-control"]')].map((node) => node.textContent)).toEqual([unavailable, unavailable]);
    expect(document.body.textContent).not.toContain("cat_missing");
    expect(document.body.textContent).not.toContain("brd_missing");
  });

  it("creates a Bangla-named category without sending a web address", async () => {
    api.create.mockResolvedValue({ id: "cat_new", revision: 1, status: "draft" });
    await openAndSearch("কুর্তা");

    await act(async () => createButton().click());
    await settle();

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create.mock.calls[0]?.[0]?.body).toEqual(expect.objectContaining({ name: "কুর্তা" }));
    expect(api.create.mock.calls[0]?.[0]?.body).not.toHaveProperty("slug");
    expect(api.success).toHaveBeenCalled();
  });

  it("shows the server's reason next to the Create button instead of a toast", async () => {
    api.create.mockRejectedValue(new AdminApiResponseError(JSON.stringify([
      { path: ["name"], code: "too_small", origin: "string", minimum: 3, message: "Too small" },
    ]), 400, "VALIDATION_ERROR"));
    await openAndSearch("ab");

    await act(async () => createButton().click());
    await settle();

    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Use at least 3 characters.");
    expect(api.error).not.toHaveBeenCalled();
  });
});
