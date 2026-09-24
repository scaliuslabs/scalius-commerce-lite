// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { AttributeDialog } from "./AttributeDialog";

const api = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), success: vi.fn(), error: vi.fn(), close: vi.fn() }));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminAttributes: api.create,
  putApiV1AdminAttributesById: api.update,
}));
vi.mock("sonner", () => ({ toast: { success: api.success, error: api.error } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AttributeDialog", () => {
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    api.create.mockResolvedValue({ id: "attr_new" });
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
  async function render() {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <AttributeDialog open onClose={api.close} />
      </QueryClientProvider>,
    ));
    await settle();
  }
  const field = (id: string) => document.getElementById(id) as HTMLInputElement;
  const text = () => document.body.textContent ?? "";
  async function type(node: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function blur(node: HTMLInputElement) {
    await act(async () => { node.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  }
  async function press(label: string) {
    const button = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.trim() === label)!;
    await act(async () => button.click());
    await settle();
  }

  it("checks fields when they are left or saved, never while typing, and never shows an empty message", async () => {
    await render();

    await type(field("attribute-name"), "ক");
    expect(text()).not.toContain("Enter a name of at least 2 characters.");
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(text()).not.toContain("undefined");

    await blur(field("attribute-name"));
    expect(text()).toContain("Enter a name of at least 2 characters.");
  });

  it("asks for an English handle when the name is in Bangla, and saves once it has one", async () => {
    await render();

    await type(field("attribute-name"), "কাপড়");
    expect(field("attribute-handle").value).toBe("");
    await press("Create");
    expect(text()).toContain("Enter at least 2 English letters or numbers, e.g. fabric.");
    expect(api.create).not.toHaveBeenCalled();

    await type(field("attribute-handle"), "Fabric Type");
    await press("Create");
    expect(api.create).toHaveBeenCalledWith({ body: { name: "কাপড়", slug: "fabric-type", filterable: true } });
    expect(api.success).toHaveBeenCalledWith("Attribute saved");
    expect(api.close).toHaveBeenCalled();
  });

  it("says when a preset value is already in the list", async () => {
    await render();
    await type(field("attribute-value"), "সুতি");
    await press("Add value");
    await type(field("attribute-value"), "সুতি ");
    await press("Add value");

    expect(text()).toContain("“সুতি” is already in the list.");
    expect(document.querySelectorAll('button[aria-label="Remove সুতি"]')).toHaveLength(1);
  });

  it("puts a taken name or handle on the handle field in plain words", async () => {
    api.create.mockRejectedValueOnce(new AdminApiResponseError("An attribute with that name or slug already exists.", 409));
    await render();
    await type(field("attribute-name"), "Fabric");
    await press("Create");

    expect(text()).toContain("Another attribute already uses this name or handle.");
    expect(field("attribute-handle").getAttribute("aria-invalid")).toBe("true");
    expect(text()).not.toContain("slug");
    expect(api.close).not.toHaveBeenCalled();
  });
});
