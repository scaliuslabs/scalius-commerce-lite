// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import type { CustomFieldType } from "@scalius/shared/custom-fields";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { Field } from "~/components/ui/field";
import { formatDateTime, setLocale, translate } from "~/i18n";
import { customFieldMessages } from "~/i18n/custom-fields";
import { formMessages } from "~/i18n/forms";
import { comboboxMessages } from "~/i18n/combobox";
import { setStoreTimeZone } from "~/lib/store-time-zone";
import { CustomFieldInput } from "./CustomFieldInput";
import { checkDraft, valueFromDraft, type CustomFieldDraft } from "./custom-field-draft";

const sdk = vi.hoisted(() => ({
  getApiV1AdminProducts: vi.fn(),
  getApiV1AdminCollections: vi.fn(),
  getApiV1AdminProductsByIds: vi.fn(),
  getApiV1AdminCollectionsByIds: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ code: "BDT", symbol: "৳" }) }));
vi.mock("~/components/admin/media-manager", () => ({ MediaManager: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const context = { decimalPlaces: 2, currencyCode: "BDT", priceIncrementMinor: 100 };
const validations = { min: null, max: null, regex: null, choices: null };
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });

function Harness({ type, initial, disabled = false }: { type: CustomFieldType; initial: CustomFieldDraft; disabled?: boolean }) {
  const [draft, setDraft] = useState(initial);
  const problem = checkDraft({ type, validations }, draft, context);
  return <>
    <Field id="when" noteId="when-note" label="Schedule" help="Local time" error={problem ? "Invalid draft" : undefined}>
      <CustomFieldInput id="when" type={type} validations={validations} draft={draft} onChange={setDraft} disabled={disabled} invalid={Boolean(problem)} describedBy="when-note" label="Schedule" />
    </Field>
    <output data-draft>{JSON.stringify(draft)}</output>
    <output data-wire>{JSON.stringify(valueFromDraft(type, draft))}</output>
  </>;
}

describe("custom field date controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks();
    setLocale("en");
    setStoreTimeZone("Asia/Dhaka");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    notifyManager.setNotifyFunction((callback) => act(callback));
    sdk.getApiV1AdminProductsByIds.mockImplementation(() => ok({ products: [{ id: "prod_a", name: "Saved product" }] }));
    sdk.getApiV1AdminCollectionsByIds.mockImplementation(() => ok({ collections: [{ id: "col_a", name: "Saved collection" }] }));
    sdk.getApiV1AdminProducts.mockImplementation(() => ok({ products: [{ id: "prod_b", name: "Other product" }], pagination: { page: 1, totalPages: 1 } }));
    sdk.getApiV1AdminCollections.mockImplementation(() => ok({ collections: [{ id: "col_b", name: "Other collection" }], pagination: { page: 1, totalPages: 1 } }));
  });
  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    host.remove();
    document.body.innerHTML = "";
    setLocale("en");
    setStoreTimeZone("Asia/Dhaka");
    notifyManager.setNotifyFunction((callback) => callback());
  });
  const show = (type: CustomFieldType, initial: CustomFieldDraft, permissions = [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.COLLECTIONS_VIEW], disabled = false) => act(async () => root.render(
    <QueryClientProvider client={client}><PermissionProvider permissions={permissions}><Harness type={type} initial={initial} disabled={disabled} /></PermissionProvider></QueryClientProvider>,
  ));
  const button = (id = "when") => document.getElementById(id) as HTMLButtonElement;
  const time = (id = "when-time") => document.getElementById(id) as HTMLInputElement;
  const draft = () => JSON.parse(host.querySelector("[data-draft]")!.textContent!);
  const wire = () => JSON.parse(host.querySelector("[data-wire]")!.textContent!);
  const openDate = async (id = "when") => {
    button(id).focus();
    await act(async () => button(id).click());
    await vi.waitFor(() => expect(document.querySelector("[data-day]")).not.toBeNull(), { timeout: 3000 });
  };
  const pick = async (day: string) => {
    const target = document.querySelector<HTMLButtonElement>(`button[data-day="${day}"]`);
    expect(target).not.toBeNull();
    await act(async () => target!.click());
  };
  const clearDate = async () => {
    const clear = [...document.querySelectorAll("button")].find((element) => element.textContent === translate(formMessages, "clearDate"));
    expect(clear).toBeDefined();
    await act(async () => clear!.click());
  };
  const typeTime = async (value: string, id = "when-time") => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(time(id), value);
    time(id).dispatchEvent(new Event("input", { bubbles: true }));
  });

  it.each(["en", "bn"] as const)("uses a named calendar date control in %s and preserves its day when cleared or changed", async (locale) => {
    setLocale(locale);
    setStoreTimeZone("America/Los_Angeles");
    await show("date", "2026-10-07");
    expect(button().tagName).toBe("BUTTON");
    expect(button().type).toBe("button");
    expect(button().getAttribute("aria-label")).toBe(`Schedule: ${button().textContent}`);
    expect(button().getAttribute("aria-describedby")).toBe("when-note");
    expect(host.querySelector('input[type="date"], input[type="datetime-local"]')).toBeNull();
    expect(button().textContent).toBe(formatDateTime(new Date("2026-10-07T00:00:00Z"), { dateStyle: "medium", timeZone: "UTC" }));
    await openDate();
    await pick("2026-10-15");
    expect(wire()).toEqual({ value: "2026-10-15" });
    await openDate();
    await clearDate();
    expect(wire()).toEqual({ value: "" });
    expect(draft()).toBe("");
  });

  it("changes only the date or time part, preserving seconds and browser-local ISO conversion", async () => {
    await show("date_time", "2026-10-07T10:11:12");
    expect(time().step).toBe("1");
    expect(time().value).toBe("10:11:12");
    expect(button().getAttribute("aria-label")).toBe(`${translate(customFieldMessages, "dateOf", { field: "Schedule" })}: ${button().textContent}`);
    expect(time().getAttribute("aria-label")).toBe(translate(customFieldMessages, "timeOf", { field: "Schedule" }));
    expect(time().getAttribute("aria-describedby")).toBe("when-note");
    await openDate();
    await pick("2026-10-15");
    expect(draft()).toBe("2026-10-15T10:11:12");
    await typeTime("18:19:20");
    expect(wire()).toEqual({ value: new Date(2026, 9, 15, 18, 19, 20).toISOString() });
    await act(async () => setStoreTimeZone("America/New_York"));
    expect(draft()).toBe("2026-10-15T18:19:20");
    expect(time().value).toBe("18:19:20");
  });

  it("keeps a missing time invalid, and clearing the date clears the whole timestamp", async () => {
    await show("date_time", "2026-10-07T10:11:12");
    await typeTime("");
    expect(draft()).toBe("2026-10-07T");
    expect(wire()).toBeNull();
    expect(button().getAttribute("aria-invalid")).toBe("true");
    expect(time().getAttribute("aria-invalid")).toBe("true");
    await openDate();
    await clearDate();
    expect(draft()).toBe("");
    expect(wire()).toEqual({ value: null });
    expect(time().disabled).toBe(true);
    expect(time().value).toBe("");
  });

  it("requires a time after choosing a day for an empty timestamp", async () => {
    await show("date_time", "");
    expect(time().disabled).toBe(true);
    await openDate();
    const day = document.querySelector<HTMLButtonElement>("button[data-day]:not([disabled])")!;
    const selected = day.dataset.day!;
    await act(async () => day.click());
    expect(draft()).toBe(`${selected}T`);
    expect(time().disabled).toBe(false);
    expect(wire()).toBeNull();
    await typeTime("00:00:01");
    expect(wire()).toEqual({ value: new Date(`${selected}T00:00:01`).toISOString() });
  });

  it.each(["list.date", "list.date_time"] as const)("edits and clears the correct %s item without touching its neighbour", async (type) => {
    const suffix = type === "list.date_time" ? "T10:11:12" : "";
    await show(type, [`2026-10-07${suffix}`, `2026-10-08${suffix}`]);
    expect(button("when-1").getAttribute("aria-label")).toContain("Schedule 2");
    await openDate("when-1");
    await pick("2026-10-15");
    expect(draft()).toEqual([`2026-10-07${suffix}`, `2026-10-15${suffix}`]);
    if (type === "list.date_time") {
      await typeTime("18:19:20", "when-1-time");
      expect(draft()).toEqual(["2026-10-07T10:11:12", "2026-10-15T18:19:20"]);
    }
    await openDate("when-1");
    await clearDate();
    expect(draft()).toEqual([`2026-10-07${suffix}`, ""]);
  });

  it("keeps calendar arrow navigation and Escape focus return before the time field", async () => {
    await show("date_time", "2026-10-07T10:11:12");
    await openDate();
    const selected = document.querySelector<HTMLButtonElement>('button[data-day="2026-10-07"]')!;
    selected.focus();
    await act(async () => { selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    await vi.waitFor(() => expect((document.activeElement as HTMLElement).dataset.day).toBe("2026-10-08"));
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await vi.waitFor(() => expect(document.activeElement).toBe(button()));
    expect(time().disabled).toBe(false);
    expect(time().tabIndex).toBe(0);
    expect(button().compareDocumentPosition(time()) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(draft()).toBe("2026-10-07T10:11:12");
  });

  it("disables both date/time controls together", async () => {
    await show("date_time", "2026-10-07T10:11:12", [], true);
    expect(button().disabled).toBe(true);
    expect(time().disabled).toBe(true);
  });

  it.each([
    ["product_reference", "prod_a", "Saved product", PERMISSIONS.PRODUCTS_VIEW],
    ["collection_reference", "col_a", "Saved collection", PERMISSIONS.COLLECTIONS_VIEW],
  ] as const)("revokes cached %s browsing without preventing an owner from clearing its ID", async (type, id, name, permission) => {
    await show(type, id, [permission]);
    await vi.waitFor(() => expect(button().textContent).toContain(name));
    const chosen = type === "product_reference" ? sdk.getApiV1AdminProductsByIds : sdk.getApiV1AdminCollectionsByIds;
    const listing = type === "product_reference" ? sdk.getApiV1AdminProducts : sdk.getApiV1AdminCollections;
    expect(chosen).toHaveBeenCalledTimes(1);
    await act(async () => button().click());
    const otherName = type === "product_reference" ? "Other product" : "Other collection";
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain(otherName));
    expect(document.querySelector<HTMLButtonElement>('[role="option"]')!.disabled).toBe(false);
    expect(listing).toHaveBeenCalledTimes(1);
    const queryKey = [type === "product_reference" ? "custom-field-products" : "custom-field-collections", "searchable-select", ""];
    const cached = client.getQueryData(queryKey);
    expect(cached).toBeDefined();
    await show(type, id, []);
    expect(button().textContent).toContain(id);
    expect(button().textContent).not.toContain(name);
    expect(document.querySelector('[role="option"]')).toBeNull();
    expect(client.getQueryData(queryKey)).toBe(cached);
    await act(async () => button().click());
    expect(document.querySelector('[role="option"]')).toBeNull();
    expect(document.body.textContent).not.toContain(otherName);
    const search = document.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(search).not.toBeNull();
    await act(async () => {
      search!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      search!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(draft()).toBe(id);
    expect(listing).toHaveBeenCalledTimes(1);
    expect(chosen).toHaveBeenCalledTimes(1);
    await act(async () => { search!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    const clear = host.querySelector<HTMLButtonElement>(`button[aria-label="${translate(comboboxMessages, "clear", { name: id })}"]`);
    expect(clear).not.toBeNull();
    await act(async () => clear!.click());
    expect(draft()).toBe("");
  });
});
