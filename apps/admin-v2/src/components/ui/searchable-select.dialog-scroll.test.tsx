// @vitest-environment happy-dom
// A searchable list opened from a field inside a modal dialog or sheet
// scrolls by wheel and touch: the dialog's scroll lock must not swallow
// gestures over the list, which is portalled outside the dialog, and the
// list must open where its rows fit rather than as a sliver.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { SearchableSelect } from "./searchable-select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushUi() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

const options = Array.from({ length: 40 }, (_, index) => ({ value: `area-${index}`, label: `Area ${index}` }));

/** happy-dom has no layout: give the list the overflow and sizes the stylesheet would. */
function scrollableList(): HTMLElement {
  const list = document.querySelector<HTMLElement>('[data-slot="searchable-select-list"]')!;
  list.style.overflowY = "auto";
  list.style.overflowX = "hidden";
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1600 });
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 240 });
  list.scrollTop = 200;
  return list;
}

function wheel(target: Element, deltaY: number) {
  const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("SearchableSelect inside a dialog", () => {
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
  });

  it("lets the wheel scroll the open list, while the page behind the dialog stays locked", async () => {
    await act(async () => root.render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Edit rate</DialogTitle>
          <DialogDescription>Where it applies</DialogDescription>
          <SearchableSelect value="" onValueChange={() => {}} options={options} ariaLabel="City" />
        </DialogContent>
      </Dialog>,
    ));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="City"]')!.click());
    await flushUi();
    const list = scrollableList();
    const option = list.querySelector('[role="option"]')!;

    expect(wheel(option, 40)).toBe(false);
    expect(wheel(option, -40)).toBe(false);
    // Outside both the list and the dialog, the page is still locked.
    expect(wheel(host, 40)).toBe(true);
  });

  it("keeps a server list's full height while its first page loads, so the popover opens where the rows fit", async () => {
    let release: () => void = () => {};
    const load = () => new Promise<{ options: typeof options; hasMore: boolean }>((resolve) => {
      release = () => resolve({ options, hasMore: false });
    });
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Try it</DialogTitle>
            <DialogDescription>City, thana and area</DialogDescription>
            <SearchableSelect value="" onValueChange={() => {}} load={load} queryKey={["cities"]} ariaLabel="City" />
          </DialogContent>
        </Dialog>
      </QueryClientProvider>,
    ));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="City"]')!.click());
    await flushUi();
    const list = () => document.querySelector<HTMLElement>('[data-slot="searchable-select-list"]')!;
    // In Chromium (a 390px bottom sheet, the field low in it) a popover sized to
    // "Loading…" stayed below and capped the arriving rows to 40px; with the
    // height reserved it opens above at the list's full 240px.
    expect(list().className.split(" ")).toContain("h-60");
    await act(async () => release());
    await vi.waitFor(() => expect(list().querySelectorAll('[role="option"]').length).toBe(options.length));
    expect(list().className.split(" ")).not.toContain("h-60");
  });
});
