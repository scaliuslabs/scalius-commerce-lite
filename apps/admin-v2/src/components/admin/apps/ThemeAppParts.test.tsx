// @vitest-environment happy-dom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminAppsByIdActivate: vi.fn(),
  postApiV1AdminAppsByIdDeactivate: vi.fn(),
  postApiV1AdminAppsByIdUninstall: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, params, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={params ? to.replace("$pluginId", params.pluginId ?? "") : to} {...props}>{children}</a>
  ),
}));

import { setLocale } from "~/i18n";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { DeactivateAppDialog, UninstallAppDialog } from "./AppDialogs";
import { ThemeAppsUnavailableAlert } from "./ThemeAppParts";
import { themeAppPartText, themeAppsUnavailable, type ThemeAppPart } from "./theme-app-parts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const parts: ThemeAppPart[] = [
  { kind: "skin", type: "noor_header", target: "header", path: "apps.skins.header.app", place: { page: "theme" }, name: "Noor header" },
  { kind: "section", type: "studio_hero", path: "pages.home.2.settings.app", place: { page: "home", index: 2 }, name: "Studio hero" },
  { kind: "section_skin", type: "hero_skin", target: "section:hero", path: "pages.landing.eid.sections.0.skin.app", place: { page: "landing", slug: "eid", index: 0 } },
  { kind: "product_block", type: "size_chart", path: "blocks.product.apps.0.app", place: { page: "template", template: "product", index: 0 }, name: "Size chart" },
  { kind: "section", type: "promo", path: "pages.templates.collection.sections.1.settings.app", place: { page: "template", template: "collection", index: 1 } },
];

const app = (themeUsage: AppDetail["themeUsage"] | undefined) =>
  ({ id: "scalius.noor", name: "Noor theme", revision: 3, status: "active", runtime: "bundled", themeUsage }) as unknown as AppDetail;

let host: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>));
}
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("theme parts an app draws", () => {
  it("reads every kind of part in plain words", () => {
    const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`;
    expect(themeAppPartText(parts[0]!, t as never)).toBe('partSkinNamed{"unit":"unit_header","name":"Noor header"}');
    expect(themeAppPartText(parts[1]!, t as never)).toBe('partSectionNamed{"page":"page_home","position":3,"name":"Studio hero"}');
  });

  it("warns which published parts fall back before the app is deactivated or uninstalled", async () => {
    await render(<DeactivateAppDialog app={app({ parts, more: 2 })} open onOpenChange={() => {}} />);
    const notice = dialog().querySelector<HTMLElement>("[data-theme-app-fallback]")!;
    expect(notice.textContent).toContain("Your live theme uses Noor theme");
    expect(notice.textContent).toContain("While Noor theme is off, these parts show your store's own design instead:");
    expect([...notice.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Header (skin 'Noor header')",
      "Home page: section 3 'Studio hero'",
      "Landing page /pages/eid: section 1 (skin)",
      "Product page app block 'Size chart'",
      "Collection pages: section 2",
      "And 2 more parts",
    ]);

    await render(<UninstallAppDialog app={app({ parts: parts.slice(0, 1), more: 0 })} open onOpenChange={() => {}} />);
    expect(dialog().querySelector("[data-theme-app-fallback]")!.textContent).toContain("Once Noor theme is removed, these parts show your store's own design instead:");
  });

  it("says nothing when the published theme does not use the app", async () => {
    await render(<DeactivateAppDialog app={app({ parts: [], more: 0 })} open onOpenChange={() => {}} />);
    expect(dialog().querySelector("[data-theme-app-fallback]")).toBeNull();
    await render(<DeactivateAppDialog app={app(undefined)} open onOpenChange={() => {}} />);
    expect(dialog().querySelector("[data-theme-app-fallback]")).toBeNull();
  });

  it("lists a refused publish's apps, why, their parts and a link to each app", async () => {
    const error = new AdminApiResponseError("Refused.", 400, "theme_apps_unavailable", {
      apps: [
        { pluginId: "scalius.noor", name: "Noor theme", reason: "app_inactive", parts: parts.slice(0, 2) },
        { pluginId: "acme.look", name: "Look", reason: "not_declared", parts: [parts[4], { kind: "bogus" }] },
        { pluginId: "acme.gone", reason: "app_inactive", parts: [] },
        { pluginId: 7 },
      ],
      moreParts: 1,
    });
    const problem = themeAppsUnavailable(error)!;
    expect(problem.apps.map((entry) => [entry.pluginId, entry.parts.length])).toEqual([["scalius.noor", 2], ["acme.look", 1], ["acme.gone", 0]]);
    expect(themeAppsUnavailable(new AdminApiResponseError("Conflict.", 409, "conflict"))).toBeNull();

    await render(<ThemeAppsUnavailableAlert apps={problem.apps} moreParts={problem.moreParts} />);
    const text = (id: string) => host.querySelector(`[data-theme-app='${id}']`)!.textContent;
    expect(text("scalius.noor")).toContain("Noor theme is not active. Activate it from its page");
    expect(text("acme.look")).toContain("Look no longer offers these parts. Remove them from the theme:Collection pages: section 2");
    expect(text("acme.gone")).toContain("acme.gone is not installed.");
    expect([...host.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Open Noor theme", "/admin/apps/scalius.noor"],
      ["Open Look", "/admin/apps/acme.look"],
      ["Open Apps", "/admin/apps"],
    ]);
    expect(host.textContent).toContain("And 1 more part not listed here.");
  });
});
