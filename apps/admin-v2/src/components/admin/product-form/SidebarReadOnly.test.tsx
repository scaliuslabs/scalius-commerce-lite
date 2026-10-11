// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { salesChannelsMessages } from "~/i18n/sales-channels";
import { warrantyMessages } from "~/i18n/warranty";
import type { SalesChannel } from "~/lib/api-query-options/sales-channels";
import type { WarrantyPolicy } from "~/lib/api-query-options/warranty";
import { PublishingChannels } from "./PublishingChannels";
import { WarrantyPolicyPicker } from "./WarrantyPolicyPicker";
import type { ProductFormValues } from "./types";
import { sortedUniqueStrings } from "~/lib/form-values";

const reads = vi.hoisted(() => ({ channels: vi.fn(), policies: vi.fn() }));
vi.mock("~/lib/api-query-options/sales-channels", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/api-query-options/sales-channels")>(),
  salesChannelsQueryOptions: () => ({ queryKey: ["sidebar-channels"], queryFn: reads.channels, staleTime: Infinity }),
}));
vi.mock("../warranty/warranty-api", () => ({
  warrantyPoliciesQueryOptions: () => ({ queryKey: ["sidebar-policies"], queryFn: reads.policies, staleTime: Infinity }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const channels: SalesChannel[] = [
  { id: "sc_online_store", name: "Online store", handle: "store", kind: "online_store", pluginId: null, status: "active", position: 0, locationIds: [], publishedProducts: 1 },
  { id: "sc_meta", name: "Facebook and Instagram", handle: "meta", kind: "catalog_feed", pluginId: null, status: "inactive", position: 1, locationIds: [], publishedProducts: 1 },
];
const policy: WarrantyPolicy = {
  id: "wrp_1", name: "Care cover", provider: "brand", durationValue: 1, durationUnit: "years", replacementDays: 7,
  terms: null, currentRevisionId: "wrr_1", revision: 1, archivedAt: "2026-01-01T00:00:00Z", version: 1, productCount: 1,
  createdAt: "2025-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

let form: UseFormReturn<ProductFormValues>;
function Harness({ kind, value, readOnly = true }: {
  kind: "publishing" | "warranty";
  value: string[] | string | null;
  readOnly?: boolean;
}) {
  form = useForm<ProductFormValues>({ defaultValues: {
    salesChannelIds: Array.isArray(value) ? sortedUniqueStrings(value) : null,
    warrantyPolicyId: typeof value === "string" ? value : null,
  } });
  void form.formState.isDirty;
  return kind === "publishing" ? <PublishingChannels form={form} readOnly={readOnly} /> : <WarrantyPolicyPicker form={form} readOnly={readOnly} />;
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  reads.channels.mockResolvedValue(channels);
  reads.policies.mockResolvedValue([policy]);
  notifyManager.setNotifyFunction((callback) => act(callback));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  host.remove();
  document.body.innerHTML = "";
  notifyManager.setNotifyFunction((callback) => callback());
});
async function render(node: ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
}
const t = (key: keyof typeof salesChannelsMessages.en) => translate(salesChannelsMessages, key);
const w = (key: keyof typeof warrantyMessages.en) => translate(warrantyMessages, key);
const noEditors = () => {
  expect(host.querySelector("input, select, [role=combobox], [role=checkbox]")).toBeNull();
  expect(form.formState.isDirty).toBe(false);
};

describe("publishing edits", () => {
  it("clears dirty after an explicit saved channel is removed and re-added in display order", async () => {
    await render(<Harness kind="publishing" value={["sc_online_store", "sc_meta"]} readOnly={false} />);
    await vi.waitFor(() => expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(2));
    const toggle = host.querySelector<HTMLElement>('[role="checkbox"]')!;
    act(() => toggle.click());
    expect(form.formState.isDirty).toBe(true);
    act(() => toggle.click());
    expect(form.getValues("salesChannelIds")).toEqual(["sc_meta", "sc_online_store"]);
    expect(form.formState.isDirty).toBe(false);
  });

  it("keeps default null publication distinct from an explicit full list", async () => {
    await render(<Harness kind="publishing" value={null} readOnly={false} />);
    await vi.waitFor(() => expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(2));
    expect(form.getValues("salesChannelIds")).toBeNull();
    expect(form.formState.isDirty).toBe(false);
    const toggle = host.querySelector<HTMLElement>('[role="checkbox"]')!;
    act(() => toggle.click());
    act(() => toggle.click());
    expect(form.formState.isDirty).toBe(true);
  });
});

describe("publishing read only", () => {
  it("separates product publication from a globally off channel and preserves navigation", async () => {
    await render(<Harness kind="publishing" value={["sc_online_store"]} />);
    await vi.waitFor(() => expect(host.querySelectorAll("li")).toHaveLength(2));
    const rows = [...host.querySelectorAll("li")];
    expect(rows.map((row) => row.querySelector('[data-slot="field-control"]')?.textContent)).toEqual([t("on"), t("off")]);
    expect(rows[1]!.textContent).toContain(t("channelOff"));
    expect(host.textContent).not.toContain(t("noChannels"));
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/admin/settings/sales-channels");
    noEditors();
  });

  it.each([{ value: [] }, { value: ["removed-channel"] }, { value: ["sc_meta"] }])("does not claim availability for none, stale ids, or only an off channel: $value", async ({ value }) => {
    await render(<Harness kind="publishing" value={value} />);
    await vi.waitFor(() => expect(host.textContent).toContain(t("noChannels")));
    if (value.includes("sc_meta")) {
      expect(host.querySelectorAll('[data-slot="field-control"]')[1]?.textContent).toBe(t("on"));
      expect(host.textContent).toContain(t("channelOff"));
    }
    noEditors();
  });

  it("does not summarize an empty channel list as available everywhere", async () => {
    reads.channels.mockResolvedValue([]);
    await render(<Harness kind="publishing" value={null} />);
    await vi.waitFor(() => expect(host.textContent).toContain(t("noChannels")));
    expect(host.textContent).not.toContain("Available on");
    noEditors();
  });

  it("keeps the concise all-active summary and its reading link", async () => {
    reads.channels.mockResolvedValue([channels[0]]);
    await render(<Harness kind="publishing" value={["sc_online_store"]} />);
    await vi.waitFor(() => expect(host.textContent).toContain("Available on Online store."));
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("a")).not.toBeNull();
    noEditors();
  });

  it("shows a failed channel read without inventing an empty publication list", async () => {
    reads.channels.mockRejectedValue(new Error("unavailable"));
    await render(<Harness kind="publishing" value={["sc_online_store"]} />);
    await vi.waitFor(() => expect(host.textContent).toContain(t("loadFailed")));
    expect(host.textContent).not.toContain(t("noChannels"));
    noEditors();
  });
});

describe("warranty read only", () => {
  it("shows the archived saved policy and its summary without a picker", async () => {
    await render(<Harness kind="warranty" value="wrp_1" />);
    await vi.waitFor(() => expect(host.textContent).toContain(translate(warrantyMessages, "archivedPolicy", { name: policy.name })));
    expect(host.textContent).toContain("1 year brand warranty");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/admin/settings/policies/warranty");
    noEditors();
  });

  it("reads a saved null immediately while policies are still loading", async () => {
    reads.policies.mockImplementation(() => new Promise(() => {}));
    await render(<Harness kind="warranty" value={null} />);
    expect(host.textContent).toContain(w("none"));
    expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
    noEditors();
  });

  it.each(["missing", "failed"])("does not claim No warranty when the saved policy is %s", async (state) => {
    if (state === "failed") reads.policies.mockRejectedValue(new Error("unavailable"));
    else reads.policies.mockResolvedValue([]);
    await render(<Harness kind="warranty" value="wrp_missing" />);
    await vi.waitFor(() => expect(host.textContent).toContain(w(state === "failed" ? "loadFailed" : "policyUnavailable")));
    expect(host.textContent).not.toContain(w("none"));
    expect(host.textContent).not.toContain("wrp_missing");
    noEditors();
  });

  it("still lets an editor remove the saved policy", async () => {
    await render(<Harness kind="warranty" value="wrp_1" readOnly={false} />);
    await vi.waitFor(() => expect(host.querySelector("[role=combobox]")).not.toBeNull());
    await act(async () => host.querySelector<HTMLButtonElement>("[role=combobox]")!.click());
    const none = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === w("none"));
    await act(async () => none!.click());
    expect(form.getValues("warrantyPolicyId")).toBeNull();
    expect(form.formState.isDirty).toBe(true);
  });
});
