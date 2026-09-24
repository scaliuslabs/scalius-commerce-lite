// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import type { MouseEvent } from "react";

import { rowClickHandler } from "./DataTableBodyRow";

function clickOn(html: string, selector: string) {
  document.body.innerHTML = html;
  const open = vi.fn();
  const target = document.querySelector(selector)!;
  rowClickHandler(open)!({ target } as unknown as MouseEvent);
  return open;
}

describe("opening a row from a click", () => {
  it("opens from plain cell content", () => {
    expect(clickOn("<table><tr><td><span id='t'>#1072</span></td></tr></table>", "#t")).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a menu item", "<div role='menu'><div role='menuitem' id='t'>Mark as paid</div></div>"],
    ["a radio menu item", "<div role='menu'><div role='menuitemradio' id='t'>Shipped</div></div>"],
    ["a checkbox menu item", "<div role='menu'><div role='menuitemcheckbox' id='t'>Notify</div></div>"],
    ["the menu's own padding", "<div role='menu' id='t'></div>"],
    ["a list option", "<div role='listbox'><div role='option' id='t'>Pathao</div></div>"],
    ["anything in a portaled overlay", "<div data-radix-popper-content-wrapper><p id='t'>Status</p></div>"],
  ])("ignores a click on %s (React bubbles portaled clicks to the row)", (_, html) => {
    expect(clickOn(html, "#t")).not.toHaveBeenCalled();
  });
});
