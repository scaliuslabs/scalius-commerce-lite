// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { revealFocusedRailItem } from "./rail-focus";

function rect(left: number, right: number): DOMRect {
  return { left, right, top: 0, bottom: 10, width: right - left, height: 10, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
}

function rail(itemRect: DOMRect) {
  document.body.innerHTML = `<ul data-h-rail><li><a href="#x">Card</a></li></ul>`;
  const track = document.querySelector<HTMLElement>("[data-h-rail]")!;
  const item = track.querySelector("li")!;
  track.getBoundingClientRect = () => rect(8, 382);
  item.getBoundingClientRect = () => itemRect;
  const calls: number[] = [];
  track.scrollBy = ((options: ScrollToOptions) => void calls.push(options.left ?? 0)) as never;
  return { link: track.querySelector("a")!, calls };
}

describe("revealFocusedRailItem", () => {
  it("scrolls a card cut off at the end fully into view with room for its ring", () => {
    const { link, calls } = rail(rect(372, 484));
    revealFocusedRailItem(link);
    expect(calls).toEqual([484 - (382 - 4)]);
  });

  it("scrolls a card cut off at the start back", () => {
    const { link, calls } = rail(rect(-40, 72));
    revealFocusedRailItem(link);
    expect(calls).toEqual([-52]);
  });

  it("leaves a card already inside alone, and ignores anything outside a rail", () => {
    const { link, calls } = rail(rect(100, 212));
    revealFocusedRailItem(link);
    revealFocusedRailItem(document.body);
    expect(calls).toEqual([]);
  });
});
