// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS as P } from "~/lib/admin-permissions";
import { setLocale, translate } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import { DiscountEditor } from "./DiscountEditor";
import { draftToInput, emptyDraft, type DiscountDraft } from "./discount-form";
import type { DiscountRecord } from "~/lib/api-query-options/discounts";

const api = vi.hoisted(() => ({ update: vi.fn(), toggle: vi.fn(), remove: vi.fn(), create: vi.fn(), fresh: vi.fn(), announce: vi.fn() }));
vi.mock("~/lib/api-mutations/discounts", () => ({
  useUpdateDiscount: () => ({ mutateAsync: api.update, isPending: false }),
  useSetDiscountActive: () => ({ mutateAsync: api.toggle, isPending: false }),
  useDeleteDiscount: () => ({ mutateAsync: api.remove, isPending: false }),
  useCreateDiscount: () => ({ mutateAsync: api.create, isPending: false }),
  discountFailureText: () => "Could not load",
}));
vi.mock("~/lib/api-query-options/discounts", () => ({
  discountQueryOptions: (id: string) => ({ queryKey: ["discount", id], queryFn: api.fresh }),
  discountsQueryOptions: ({ view }: { view: string }) => ({ queryKey: ["discounts", view], queryFn: async () => ({ discounts: [] }) }),
}));
vi.mock("./ScopeField", () => ({
  useScopeItems: ({ ids }: { ids: string[] }) => new Map(ids.map((id) => [id, { id, name: `Product ${id}` }])),
  useScopeLabel: () => ({ ids }: { ids: string[] }) => ids.join(", "),
  ScopeField: () => <button type="button" data-picker>Pick items</button>,
}));
vi.mock("./SegmentField", () => ({
  useSegmentNames: () => ({ names: new Map([["vip", "VIP"], ["dhaka", "Dhaka buyers"], ["loyal", "Loyal customers"]]), query: { isPending: false } }),
  useSegmentLabel: () => (ids: string[]) => ids.join(", "),
  SegmentField: () => <button type="button" data-picker>Pick segments</button>,
}));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ symbol: "৳", code: "BDT", priceIncrementMinor: 100, fmt: (value: number) => `৳${value}` }) }));
vi.mock("~/components/admin/states/ReadOnlyNotice", () => ({ ReadOnlyNotice: () => <div data-readonly-notice>Read-only</div> }));
vi.mock("~/lib/realtime/store", () => ({
  presenceKey: (prefix: string, id: string) => `${prefix}:${id}`,
  announceSave: api.announce,
  PresenceSlot: ({ presenceKey, revision, dirty, readOnly }: { presenceKey: string | null; revision: number; dirty: boolean; readOnly: boolean }) => <span data-presence={presenceKey} data-revision={revision} data-dirty={dirty} data-readonly={readOnly} />,
}));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  useNavigate: () => vi.fn(),
  useLocation: ({ select }: { select?: (value: { hash: string }) => unknown } = {}) => select ? select({ hash: "" }) : { hash: "" },
  Link: ({ children, to, params: _params, ...props }: { children: ReactNode; to: string; params?: unknown }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function record(type: DiscountDraft["type"] = "products", patch: Partial<DiscountDraft> = {}, revision = 3): DiscountRecord {
  const input = draftToInput({ ...emptyDraft(type, Date.UTC(2026, 0, 1)), code: "SAVED20", value: "20", minimum: "amount", minimumValue: "100", appliesTo: { kind: "products", ids: ["one", "two", "three"] }, buyScope: { kind: "products", ids: ["one"] }, getScope: { kind: "products", ids: ["two"] }, buyValue: "2", getQuantity: "1", getValueKind: "free", eligibility: "segments", customerSegmentIds: ["vip", "dhaka", "loyal"], limitTotal: true, totalUses: "50", oncePerCustomer: true, ...patch }, "BDT");
  return {
    ...input, id: "promo_saved", revision, status: "active", priority: 100, conflictPolicy: "best", combinesWith: input.combinesWith!,
    title: input.title ?? null, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null,
    timezone: "Asia/Dhaka", maxRedemptions: input.maxRedemptions ?? null, maxRedemptionsPerCustomer: input.maxRedemptionsPerCustomer ?? null,
    currency: "BDT", maxDiscountSpendMinor: null, budgetCurrencyCode: null, redemptionCount: 7, customerRedemptionCount: 0, discountSpendMinor: 0,
    createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z", deletedAt: null,
    codes: (input.codes ?? []).map(({ code }) => ({ code, isActive: true })),
    conditions: (input.conditions ?? []).map((condition, index) => ({ id: `c${index}`, ...condition })),
    effects: input.effects.map((effect, index) => ({ id: `e${index}`, ...effect })),
  } as DiscountRecord;
}
const t = (key: keyof typeof discountsMessages.en) => translate(discountsMessages, key);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks(); setLocale("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; client.clear(); setLocale("en"); });
async function render(discount: DiscountRecord | undefined, permissions: string[] = []) {
  await act(async () => root.render(<QueryClientProvider client={client}><PermissionProvider permissions={permissions}><DiscountEditor type={discount ? "products" : "order"} discount={discount} /></PermissionProvider></QueryClientProvider>));
}
async function typeCode(value: string) {
  await act(async () => {
    const input = document.getElementById("discount-code") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("discount saved-value mode", () => {
  it.each(["products", "order", "shipping", "buy_get"] as const)("renders saved %s rules without mutation controls", async (type) => {
    await render(record(type));
    expect(host.querySelector("input, textarea, [role=radio], [role=checkbox], [data-picker]")).toBeNull();
    expect(host.textContent).toContain("SAVED20");
    expect(host.textContent).toContain("Loyal customers");
    expect(host.textContent).toContain("Used 7 times");
    expect(host.textContent).toContain(t("endDate"));
    if (type === "products") expect(host.textContent).toContain("Product three");
    if (type === "buy_get") expect(host.textContent).toContain("Gets 1 item from Product two free");
    expect(button(t("delete"))).toBeUndefined();
    expect(button(t("deactivate"))).toBeUndefined();
    expect(host.querySelector('[data-presence="discount:promo_saved"]')?.getAttribute("data-readonly")).toBe("true");
  });

  it("shows saved values in Bangla and automatic discount titles", async () => {
    setLocale("bn");
    await render(record("order", { method: "automatic", title: "Saved automatic title" }));
    expect(host.textContent).toContain("Saved automatic title");
    expect(host.textContent).toContain(t("methodAutomaticTab"));
    expect(host.querySelector("input, textarea, [data-picker]")).toBeNull();
  });

  it("hides a revoked draft and picker controls, then uses the latest revision for an independently permitted toggle", async () => {
    await render(record(), [P.DISCOUNTS_EDIT]);
    await typeCode("LOCAL99");
    const newer = record("products", { code: "SERVER30" }, 4);
    await render(newer, [P.DISCOUNTS_TOGGLE_STATUS]);
    expect(host.textContent).not.toContain("LOCAL99");
    expect(host.textContent).toContain("SERVER30");
    expect(host.querySelector("input, [data-picker]")).toBeNull();
    expect(host.querySelector('[data-presence="discount:promo_saved"]')?.getAttribute("data-dirty")).toBe("false");
    api.toggle.mockResolvedValue({ revision: 5, status: "inactive" });
    await act(async () => button(t("deactivate"))!.click());
    expect(api.toggle).toHaveBeenCalledWith({ id: newer.id, expectedRevision: 4, active: false });
    expect(api.announce).toHaveBeenCalledWith("discount:promo_saved", 5);
    expect(host.textContent).toContain("SERVER30");
    expect(host.textContent).not.toContain("SAVED20");
    expect(api.update).not.toHaveBeenCalled();
    await render(newer, [P.DISCOUNTS_EDIT]);
    expect(host.querySelector<HTMLInputElement>("#discount-code")?.value).toBe("SERVER30");
    expect(host.querySelector('[data-presence="discount:promo_saved"]')?.getAttribute("data-dirty")).toBe("false");
  });

  it("keeps independent delete access but unmounts its dialog when permission is revoked", async () => {
    await render(record(), [P.DISCOUNTS_DELETE]);
    await act(async () => button(t("delete"))!.click());
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await render(record(), []);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("does not expose an empty editor without create permission", async () => {
    await render(undefined);
    expect(host.querySelector("[data-readonly-notice]")).not.toBeNull();
    expect(host.querySelector("input, textarea, [data-picker]")).toBeNull();
    expect(host.querySelector("[data-presence]")).toBeNull();
  });
});
