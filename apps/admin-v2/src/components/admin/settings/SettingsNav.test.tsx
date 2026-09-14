// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsNav } from "./SettingsNav";
import {
  getVisibleSettingsNavGroups,
  isSettingsNavItemCurrent,
  SETTINGS_INDEX_PATH,
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
  settingsNavRouteHrefs,
} from "./settings-navigation";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Every settings destination an operator can reach, in one place. */
const EXPECTED_ROUTE_HREFS = [
  "/admin/settings/theme",
  "/admin/settings/hero-sliders",
  "/admin/settings/checkout",
  "/admin/settings/taxes",
  "/admin/settings/delivery-providers",
  "/admin/settings/fraud-checker",
  "/admin/settings/notifications",
  "/admin/settings/meta-conversion",
  "/admin/settings/account",
  "/admin/settings/agent-access",
  "/admin/settings/cache",
];

const EXPECTED_SECTION_IDS = [
  "header",
  "footer",
  "seo",
  "storefront",
  "media",
  "business",
  "currency",
  "countries",
  "email",
  "auth",
  "security",
  "scanner",
  "platform",
];

describe("settings navigation data", () => {
  it("lists every general section and every standalone settings route once", () => {
    expect(settingsNavRouteHrefs().sort()).toEqual(
      [...EXPECTED_ROUTE_HREFS].sort(),
    );

    const sectionIds = SETTINGS_NAV_ITEMS.filter(
      (item) => item.kind === "section",
    ).map((item) => item.id);
    expect(sectionIds.sort()).toEqual([...EXPECTED_SECTION_IDS].sort());

    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every destination a one-line description for its page header", () => {
    for (const item of SETTINGS_NAV_ITEMS) {
      expect(item.description.length).toBeGreaterThan(20);
      expect(item.description).not.toContain("!");
      expect(item.description.endsWith(".")).toBe(true);
    }
  });

  it("marks a section current only while the general settings index is open", () => {
    const media = SETTINGS_NAV_ITEMS.find((item) => item.id === "media")!;
    const theme = SETTINGS_NAV_ITEMS.find((item) => item.id === "theme")!;

    expect(
      isSettingsNavItemCurrent(media, {
        pathname: SETTINGS_INDEX_PATH,
        section: "media",
      }),
    ).toBe(true);
    expect(
      isSettingsNavItemCurrent(media, {
        pathname: SETTINGS_INDEX_PATH,
        section: "platform",
      }),
    ).toBe(false);
    expect(
      isSettingsNavItemCurrent(media, { pathname: "/admin/settings/theme" }),
    ).toBe(false);
    expect(
      isSettingsNavItemCurrent(theme, { pathname: "/admin/settings/theme/" }),
    ).toBe(true);
  });

  it("keeps a settings route current on its own child routes", () => {
    const agentAccess = SETTINGS_NAV_ITEMS.find(
      (item) => item.id === "agent-access",
    )!;
    expect(
      isSettingsNavItemCurrent(agentAccess, {
        pathname: "/admin/settings/agent-access/authorize/req_1",
      }),
    ).toBe(true);
    expect(
      isSettingsNavItemCurrent(agentAccess, { pathname: "/admin/settings" }),
    ).toBe(false);
  });

  it("hides destinations the operator has no permission for", () => {
    const groups = getVisibleSettingsNavGroups(
      new Set([ADMIN_PERMISSIONS.TAXES_VIEW]),
      false,
    );
    const hrefs = groups
      .flatMap((group) => group.items)
      .filter((item) => item.kind === "route")
      .map((item) => item.href);

    expect(hrefs).toContain("/admin/settings/taxes");
    expect(hrefs).toContain("/admin/settings/account");
    expect(hrefs).not.toContain("/admin/settings/cache");
    expect(hrefs).not.toContain("/admin/settings/agent-access");
  });

  it("gives a super admin every destination", () => {
    const groups = getVisibleSettingsNavGroups(undefined, true);
    expect(groups.flatMap((group) => group.items)).toHaveLength(
      SETTINGS_NAV_ITEMS.length,
    );
  });
});

describe("SettingsNav", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  function render(node: React.ReactNode) {
    act(() => root.render(node));
  }

  it("renders every destination and highlights only the current one", () => {
    render(
      <SettingsNav
        groups={[...SETTINGS_NAV_GROUPS]}
        location={{ pathname: SETTINGS_INDEX_PATH, section: "platform" }}
        onSelectSection={() => {}}
      />,
    );

    const nav = host.querySelector('nav[aria-label="Settings"]')!;
    expect(nav).not.toBeNull();
    expect(nav.querySelectorAll("li")).toHaveLength(SETTINGS_NAV_ITEMS.length);

    for (const href of EXPECTED_ROUTE_HREFS) {
      expect(nav.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
    for (const id of EXPECTED_SECTION_IDS) {
      expect(
        nav.querySelector(`button[data-settings-nav-section="${id}"]`),
      ).not.toBeNull();
    }

    const current = nav.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute("data-settings-nav-section")).toBe(
      "platform",
    );
  });

  it("highlights the standalone route the operator is on", () => {
    render(
      <SettingsNav
        groups={[...SETTINGS_NAV_GROUPS]}
        location={{ pathname: "/admin/settings/delivery-providers" }}
        onSelectSection={() => {}}
      />,
    );

    const current = host.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute("href")).toBe(
      "/admin/settings/delivery-providers",
    );
  });

  it("opens a general section without leaving the page", () => {
    const onSelectSection = vi.fn();
    render(
      <SettingsNav
        groups={[...SETTINGS_NAV_GROUPS]}
        location={{ pathname: SETTINGS_INDEX_PATH, section: "header" }}
        onSelectSection={onSelectSection}
      />,
    );

    act(() => {
      host
        .querySelector<HTMLButtonElement>('[data-settings-nav-section="seo"]')!
        .click();
    });

    expect(onSelectSection).toHaveBeenCalledTimes(1);
    expect(onSelectSection.mock.calls[0][0].section).toBe("seo");
  });

  it("shows what each destination controls in the mobile index variant", () => {
    render(
      <SettingsNav
        groups={[...SETTINGS_NAV_GROUPS]}
        location={{ pathname: SETTINGS_INDEX_PATH, section: "header" }}
        onSelectSection={() => {}}
        variant="index"
      />,
    );

    const nav = host.querySelector('nav[aria-label="Settings"]')!;
    expect(nav.getAttribute("data-settings-nav")).toBe("index");
    for (const item of SETTINGS_NAV_ITEMS) {
      expect(nav.textContent).toContain(item.description);
    }
  });

  it("uses the router-aware link when one is supplied", () => {
    render(
      <SettingsNav
        groups={[...SETTINGS_NAV_GROUPS]}
        location={{ pathname: SETTINGS_INDEX_PATH, section: "header" }}
        onSelectSection={() => {}}
        linkComponent={({ href, children, ...rest }) => (
          <a data-router-link="" href={href} {...rest}>
            {children}
          </a>
        )}
      />,
    );

    expect(host.querySelectorAll("[data-router-link]")).toHaveLength(
      EXPECTED_ROUTE_HREFS.length,
    );
  });
});
