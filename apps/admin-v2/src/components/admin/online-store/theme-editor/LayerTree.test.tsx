// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { LayerTree, type TreeGroupModel } from "./LayerTree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const move = vi.fn();
const select = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // Real dnd-kit sensors and collision detection, with deterministic row geometry.
  // Native touch scrolling and CSS hit areas are verified in the browser.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rows = [...container.querySelectorAll("[data-tree-row]")];
    const index = rows.indexOf(this.closest("[data-tree-row]")!);
    return new DOMRect(0, Math.max(0, index) * 44, 320, index >= 0 ? 44 : 440);
  });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
});

afterEach(async () => {
  act(() => root.unmount());
  // The sensor removes its click-suppression listener 50ms after a gesture ends.
  await new Promise((resolve) => setTimeout(resolve, 60));
  container.remove();
  vi.restoreAllMocks();
});

function render(groups: TreeGroupModel[] = [{ id: "page", label: "Page", items: [
  { id: "hero", name: "Hero", move: { list: "page", index: 0, count: 2 } },
  { id: "details", name: "Product details", move: { list: "page", index: 1, count: 2 } },
] }], expandTo: string[] = []) {
  act(() => root.render(<LayerTree groups={groups} selected={null} onSelect={select} onHover={() => {}} onMove={move} expandTo={expandTo} />));
}

const row = (id: string) => container.querySelector<HTMLElement>(`[data-tree-row="${id}"]`)!;
const grip = (id: string) => row(id).querySelector<HTMLButtonElement>('button[aria-roledescription="sortable"]')!;

async function pointer(target: EventTarget, type: string, y: number, extra: Partial<PointerEventInit> = {}) {
  const event = new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
    button: 0, buttons: type === "pointerup" ? 0 : 1, pointerType: "touch", clientX: 20, clientY: y, ...extra,
  });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

async function startDrag(id = "hero", y = 22) {
  await pointer(grip(id), "pointerdown", y);
  await pointer(document, "pointermove", y + 6);
}

describe("layer tree touch handles", () => {
  it("names its native grip and keeps keyboard focus on the tree row", () => {
    render();
    expect(grip("hero").getAttribute("type")).toBe("button");
    expect(grip("hero").getAttribute("aria-label")).toContain("Hero");
    expect(grip("hero").getAttribute("aria-hidden")).toBeNull();
    expect(grip("hero").tabIndex).toBe(-1);
    expect(row("hero").tabIndex).toBe(0);
    const description = document.getElementById(grip("hero").getAttribute("aria-describedby")!);
    expect(description?.textContent).toContain("To move a row, press Space, move it with the arrow keys, then press Space again.");
  });

  it("commits a touch reorder exactly once on drop and does not select from the trailing click", async () => {
    render();
    await startDrag();
    await pointer(document, "pointermove", 70);
    expect(move).not.toHaveBeenCalled();
    await pointer(document, "pointerup", 70);
    expect(move.mock.calls).toEqual([["page", 0, 1]]);
    act(() => grip("hero").click());
    expect(select).not.toHaveBeenCalled();
  });

  it("leaves gestures on the row available for native list scrolling", async () => {
    render();
    await pointer(row("hero"), "pointerdown", 22);
    const event = await pointer(document, "pointermove", 70);
    await pointer(document, "pointerup", 70);
    expect(event.defaultPrevented).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });

  it("does not reorder or select from a grip tap below the activation distance", async () => {
    render();
    await pointer(grip("hero"), "pointerdown", 22);
    await pointer(document, "pointermove", 25);
    await pointer(document, "pointerup", 25);
    act(() => grip("hero").click());
    expect(move).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row("hero"));
  });

  it.each(["pointercancel", "Escape"])("cancels an active touch drag with %s without changing order", async (method) => {
    render();
    await startDrag();
    await pointer(document, "pointermove", 70);
    if (method === "pointercancel") await pointer(document, "pointercancel", 70);
    else await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); });
    await pointer(document, "pointerup", 70);
    expect(move).not.toHaveBeenCalled();
  });

  it("rejects a drop into a child module list and keeps a fixed template's removal unavailable", async () => {
    render([{ id: "page", label: "Page", items: [
      { id: "hero", name: "Hero", move: { list: "page", index: 0, count: 2 } },
      { id: "details", name: "Product details", move: { list: "page", index: 1, count: 2 }, children: [
        { id: "reviews", name: "Reviews", move: { list: "modules", index: 0, count: 1 } },
      ] },
    ] }], ["details"]);
    await startDrag();
    await pointer(document, "pointermove", 114);
    await pointer(document, "pointerup", 114);
    expect(move).not.toHaveBeenCalled();
    act(() => row("details").focus());
    act(() => row("details").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
    expect(row("details")).toBeTruthy();
  });

  it("offers no grip when the row has no move permission", () => {
    render([{ id: "page", label: "Page", items: [{ id: "hero", name: "Hero" }] }]);
    expect(grip("hero")).toBeNull();
  });

  it("retains the menu and Alt+arrow move alternatives", async () => {
    render();
    act(() => row("hero").focus());
    act(() => row("hero").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true })));
    expect(move.mock.calls).toEqual([["page", 0, 1]]);
    move.mockClear();
    act(() => row("hero").dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true })));
    const down = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Move down")!;
    expect(down).toBeTruthy();
    await act(async () => { down.click(); });
    expect(move.mock.calls).toEqual([["page", 0, 1]]);
  });
});
