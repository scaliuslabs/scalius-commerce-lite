// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Form } from "~/components/ui/form";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { OrganizationCard } from "./OrganizationCard";
import type { ProductFormValues } from "./types";

const api = vi.hoisted(() => ({ create: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({ postApiV1AdminCategories: api.create }));
vi.mock("sonner", () => ({ toast: { success: api.success, error: api.error } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const form = useForm<ProductFormValues>({ defaultValues: { categoryId: "" } });
  return (
    <Form {...form}>
      <OrganizationCard form={form} categories={[{ id: "cat_1", name: "Kurta", status: "published" }]} />
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
    await settle();
    const input = document.querySelector("[cmdk-input]") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  }
  const createButton = () =>
    Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.includes("Create"))!;

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
