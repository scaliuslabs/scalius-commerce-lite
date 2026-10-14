// @vitest-environment happy-dom

import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { usersMessages } from "~/i18n/settings-users";
import type { AdminUser } from "~/lib/api-query-options/rbac";

const fixture = vi.hoisted(() => ({
  post: vi.fn(), staff: vi.fn(), navigate: vi.fn(),
  viewer: { id: "manager", isOwner: false, permissions: new Set<string>(), canManageStaff: true, canManageRoles: false },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  // The route plugin splits a route's page and loader into lazy chunks (lazyRouteComponent, lazyFn).
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  createFileRoute: () => (options: object) => ({ options, useParams: () => ({ userId: "staff_1" }) }),
  useNavigate: () => fixture.navigate,
  useLocation: () => "",
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("~/components/admin/settings/UsersSettings", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/components/admin/settings/UsersSettings")>(),
  useViewer: () => fixture.viewer,
}));
vi.mock("~/lib/api-query-options/settings-screens", () => ({
  staffQuery: { queryKey: ["staff-detail-test"], queryFn: fixture.staff },
  rolesQuery: { queryKey: ["staff-roles-test"], queryFn: async () => [] },
}));
vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>();
  return { ...actual, apiClient: { ...actual.apiClient, post: fixture.post } };
});
vi.mock("~/lib/realtime/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/realtime/store")>(),
  PresenceSlot: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { Route } from "./users_.$userId";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const member: AdminUser = {
  id: "staff_1", name: "Samira Rahman", email: "samira.rahman@example.test", emailVerified: true, image: null,
  twoFactorEnabled: true, mustChangePassword: false, mustEnrollTwoFactor: false, suspended: false,
  invitation: null, isSuperAdmin: false, createdAt: "2026-01-01T00:00:00Z", roles: [], rolesTruncated: false,
  overrides: { grants: [], denials: [] }, overridesTruncated: false,
};
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let network: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  notifyManager.setNotifyFunction((callback) => act(callback));
  fixture.post.mockResolvedValue({ data: { success: true, data: { message: "Removed" } } });
  network = vi.fn(() => { throw new Error("Unexpected network request"); });
  vi.stubGlobal("fetch", network);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
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
  vi.unstubAllGlobals();
  setLocale("en");
});

async function render(overrides: Partial<AdminUser> = {}) {
  const saved = { ...member, ...overrides };
  fixture.staff.mockResolvedValue([saved]);
  client.setQueryData(["staff-detail-test"], [saved]);
  client.setQueryData(["staff-roles-test"], []);
  const Page = Route.options.component as ComponentType & { preload?: () => Promise<void> };
  await Page.preload?.();
  await act(async () => root.render(<QueryClientProvider client={client}><Page /></QueryClientProvider>));
}
const t = (key: keyof typeof usersMessages.en) => translate(usersMessages, key);
const removeTrigger = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("removeStaff"))!;

describe("staff detail presentation", () => {
  it.each([
    { locale: "en" as const, twoFactorEnabled: true, mustEnrollTwoFactor: false },
    { locale: "bn" as const, twoFactorEnabled: false, mustEnrollTwoFactor: false },
    { locale: "en" as const, twoFactorEnabled: true, mustEnrollTwoFactor: true },
  ])("shows identity and the stored two-step flag ($locale, enabled=$twoFactorEnabled)", async ({ locale, ...facts }) => {
    setLocale(locale);
    await render(facts);
    expect(host.querySelector("h1")?.textContent).toBe(member.name);
    const heading = [...host.querySelectorAll("h2")].find((node) => node.textContent === t("staffDetails"));
    expect(heading).toBeDefined();
    expect([...host.querySelectorAll("h1, h2, h3")].some((node) => node.textContent === member.email)).toBe(false);
    const card = heading!.closest('[data-slot="card"]')!;
    expect([...card.querySelectorAll('[data-slot="field-label"]')].map((node) => node.textContent)).toEqual([t("email"), t("twoStepSignIn")]);
    expect([...card.querySelectorAll('[data-slot="field-control"]')].map((node) => node.textContent)).toEqual([member.email, t(facts.twoFactorEnabled ? "twoStepOn" : "twoStepOff")]);
    expect(card.textContent).not.toMatch(/last active|session/i);
    const status = host.querySelector('[data-slot="page-actions"]')?.textContent;
    if (facts.mustEnrollTwoFactor || !facts.twoFactorEnabled) {
      expect(status).toBe(t("two_factor_setup"));
      if (locale === "en") expect(status).toBe("Two-step setup required");
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps removal quiet and requires the existing destructive confirmation", async () => {
    await render();
    expect(removeTrigger().classList.contains("bg-destructive")).toBe(false);
    await act(async () => removeTrigger().click());
    let dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(translate(usersMessages, "removeTitle", { name: member.name }));
    expect(fixture.post).not.toHaveBeenCalled();
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === translate(settingsMessages, "cancel"))!;
    await act(async () => cancel.click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(fixture.post).not.toHaveBeenCalled();
    await act(async () => removeTrigger().click());
    dialog = document.querySelector('[role="alertdialog"]')!;
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("removeStaff"))!;
    expect(confirm.classList.contains("bg-destructive")).toBe(true);
    await act(async () => confirm.click());
    expect(fixture.post).toHaveBeenCalledTimes(1);
    expect(fixture.post).toHaveBeenCalledWith({ url: "/api/v1/admin/auth/users/{id}/remove", path: { id: member.id } });
    expect(network).not.toHaveBeenCalled();
  });
});
