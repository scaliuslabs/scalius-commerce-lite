// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttributeValuesPayload } from "~/lib/api-functions/attributes";
import { queryKeys } from "~/lib/query-keys";
import { AttributeValueEditor } from "./AttributeValueEditor";

const api = vi.hoisted(() => ({
  read: vi.fn(), add: vi.fn(), rename: vi.fn(), remove: vi.fn(),
  success: vi.fn(), error: vi.fn(), close: vi.fn(),
}));
vi.mock("~/lib/api-functions/attributes", () => ({
  getAttributeValues: api.read, addAttributeValue: api.add,
  renameAttributeValue: api.rename, removeAttributeValue: api.remove,
}));
vi.mock("sonner", () => ({ toast: { success: api.success, error: api.error } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("attribute value commands", () => {
  let root: Root;
  let client: QueryClient;
  let stored: AttributeValuesPayload;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    stored = {
      attributeId: "attribute-a", attributeName: "QA attribute", totalProducts: 0,
      values: [{ value: "Original", productCount: 0, createdAt: 0, isPreset: true, sampleProducts: [] }],
      totalValues: 1, page: 1, limit: 20, totalPages: 1,
    };
    api.read.mockImplementation(async () => structuredClone(stored));
    api.add.mockResolvedValue({}); api.rename.mockResolvedValue({}); api.remove.mockResolvedValue({});
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); client.clear(); document.body.innerHTML = ""; vi.restoreAllMocks(); });
  async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
  async function render(id: string | null = "attribute-a") {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <AttributeValueEditor key={id ?? "closed"} attributeId={id} attributeName="QA attribute" onClose={api.close} />
    </QueryClientProvider>));
    await settle();
  }
  function input(label: string) { return document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; }
  function isDisabled(node: HTMLInputElement | HTMLButtonElement) {
    // Happy DOM does not include disabled fieldset ancestors in :disabled.
    return node.disabled || Boolean(node.closest<HTMLFieldSetElement>("fieldset")?.disabled);
  }
  function button(label: string) {
    return Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find(node => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === label)!;
  }
  async function click(node: HTMLElement) { await act(async () => { node.click(); }); await settle(); }
  async function type(node: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function key(node: HTMLElement, value: string) {
    node.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  }
  async function begin(kind: "add" | "rename") {
    await render();
    await click(button(kind === "add" ? "Add Value" : "Rename Original"));
    const field = input(kind === "add" ? "New attribute value" : "New value for Original");
    await type(field, "Submitted");
    return { field, save: button(kind === "add" ? "Save new value" : "Save rename for Original"),
      cancel: button(kind === "add" ? "Cancel adding value" : "Cancel rename for Original") };
  }

  for (const kind of ["add", "rename"] as const) {
    it(`locks ${kind} drafts and dismissal until the successful command refreshes`, async () => {
      const pending = deferred<object>(); api[kind].mockReturnValueOnce(pending.promise);
      const { field, save, cancel } = await begin(kind);
      await click(save);
      expect(isDisabled(field)).toBe(true);
      expect(isDisabled(input("Search attribute values"))).toBe(true);
      expect(isDisabled(cancel)).toBe(true);
      await click(cancel);
      await act(async () => { key(field, "Escape"); });
      await click(button("Close"));
      expect(api.close).not.toHaveBeenCalled();
      expect(field.isConnected).toBe(true);
      expect(field.value).toBe("Submitted");
      const refresh = deferred<AttributeValuesPayload>(); api.read.mockReturnValueOnce(refresh.promise);
      await act(async () => { pending.resolve({}); }); await settle();
      expect(isDisabled(input("Search attribute values"))).toBe(true);
      await act(async () => { refresh.resolve(stored); }); await settle();
      expect(isDisabled(input("Search attribute values"))).toBe(false);
      expect(field.isConnected).toBe(false);
      expect(api.success).toHaveBeenCalledTimes(1);
      expect(api.error).not.toHaveBeenCalled();
    });

    it(`prevents same-tick duplicate ${kind} commands and preserves a rejected draft for retry`, async () => {
      const pending = deferred<object>(); api[kind].mockReturnValueOnce(pending.promise);
      const { field, save } = await begin(kind);
      await act(async () => { key(field, "Enter"); key(field, "Enter"); save.click(); }); await settle();
      expect(api[kind]).toHaveBeenCalledTimes(1);
      await act(async () => { pending.reject(new Error("Value conflicts with an existing value")); }); await settle();
      expect(field.isConnected).toBe(true);
      expect(isDisabled(field)).toBe(false);
      expect(field.value).toBe("Submitted");
      expect(api.error).toHaveBeenCalledTimes(1);
      await type(field, "Corrected"); await click(save);
      expect(api[kind]).toHaveBeenCalledTimes(2);
      expect(api[kind].mock.calls[1][0].data).toMatchObject(kind === "add"
        ? { attributeId: "attribute-a", value: "Corrected" }
        : { attributeId: "attribute-a", oldValue: "Original", newValue: "Corrected" });
      expect(field.isConnected).toBe(false);
    });
  }

  it("keeps deletion confirmation busy, prevents duplicate commands, and allows retry after failure", async () => {
    const pending = deferred<object>(); api.remove.mockReturnValueOnce(pending.promise);
    await render(); await click(button("Delete Original"));
    const confirm = button("Delete");
    await act(async () => { confirm.click(); confirm.click(); }); await settle();
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(button("Deleting...").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await act(async () => { key(button("Cancel"), "Escape"); });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () => { pending.reject(new Error("Delete unavailable")); }); await settle();
    expect(button("Delete").disabled).toBe(false);
    expect(api.error).toHaveBeenCalledTimes(1);
    await click(button("Delete"));
    expect(api.remove).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("reports a failed confirming read as a retryable read failure after an acknowledged write", async () => {
    const { save } = await begin("add");
    api.read.mockRejectedValueOnce(new Error("Read unavailable"));
    await click(save);
    expect(api.add).toHaveBeenCalledTimes(1);
    expect(api.success).toHaveBeenCalledTimes(1);
    expect(api.error).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Could not load attribute values");
    expect(isDisabled(button("Retry"))).toBe(false);
    await click(button("Retry"));
    expect(document.body.textContent).not.toContain("Could not load attribute values");
    expect(api.add).toHaveBeenCalledTimes(1);
  });

  it("keeps a new attribute's draft isolated from an earlier mounted editor's late acknowledgment", async () => {
    const pending = deferred<object>(); api.add.mockReturnValueOnce(pending.promise);
    const { save } = await begin("add"); await click(save);
    await render(null); await render("attribute-b");
    await click(button("Add Value"));
    const field = input("New attribute value"); await type(field, "New editor draft");
    await act(async () => { pending.resolve({}); }); await settle();
    expect(field.isConnected).toBe(true);
    expect(field.value).toBe("New editor draft");
    expect(isDisabled(field)).toBe(false);
    expect(api.add.mock.calls[0][0].data.attributeId).toBe("attribute-a");
  });

  it("preserves an idle rename draft during a background query refresh", async () => {
    const { field } = await begin("rename");
    stored.totalProducts = 1;
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attributes.all }); }); await settle();
    expect(field.value).toBe("Submitted");
    expect(isDisabled(field)).toBe(false);
    expect(api.rename).not.toHaveBeenCalled();
  });
});
