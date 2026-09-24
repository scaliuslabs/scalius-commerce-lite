// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { PermissionChecklist } from "./UsersSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current = new Set<string>();

function Editor({ grantable }: { grantable?: (permission: string) => boolean }) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  current = checked;
  return <PermissionChecklist id="role" checked={checked} disabled={false} canGrant={grantable} onChange={setChecked} />;
}

function render(grantable?: (permission: string) => boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Editor grantable={grantable} />));
  const box = (name: string) =>
    [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((element) =>
      (element.getAttribute("aria-label") ?? element.closest("label")?.textContent ?? "") === name)!;
  const click = (element: HTMLElement) => act(() => element.click());
  const open = (section: string) =>
    click([...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith(section))!);
  return { box, click, open, unmount: () => act(() => root.unmount()) };
}

describe("role permission checklist", () => {
  it("ticks what a permission needs and unticks what depends on it", () => {
    const ui = render();
    ui.open("Products");
    ui.click(ui.box("Edit products"));
    expect(current).toEqual(new Set([PERMISSIONS.PRODUCTS_EDIT, PERMISSIONS.PRODUCTS_VIEW]));
    expect(ui.box("View products").getAttribute("aria-checked")).toBe("true");

    ui.click(ui.box("View products"));
    expect(current).toEqual(new Set());
    ui.unmount();
  });

  it("selects a whole section with its All box, and shows a partial section as mixed", () => {
    const ui = render();
    ui.click(ui.box("All Home permissions"));
    expect(current).toEqual(new Set([PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.DASHBOARD_ANALYTICS]));

    ui.open("Home");
    ui.click(ui.box("View sales numbers on home"));
    expect(ui.box("All Home permissions").getAttribute("aria-checked")).toBe("mixed");
    ui.unmount();
  });

  it("never lets the viewer hand out access they don't have", () => {
    const ui = render((permission) => permission !== PERMISSIONS.ORDERS_REFUND);
    ui.open("Orders");
    expect(ui.box("Refund orders").hasAttribute("disabled")).toBe(true);
    ui.click(ui.box("All Orders permissions"));
    expect(current.has(PERMISSIONS.ORDERS_REFUND)).toBe(false);
    expect(current.has(PERMISSIONS.ORDERS_ISSUE_INVOICE)).toBe(true);
    ui.unmount();
  });
});
