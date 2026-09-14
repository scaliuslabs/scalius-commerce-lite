// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexFilters } from "./IndexFilters";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("IndexFilters", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function render(ui: ReactNode) {
    await act(async () => {
      root.render(ui);
    });
  }

  async function type(target: HTMLInputElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function search() {
    return host.querySelector<HTMLInputElement>('[data-testid="index-filters-search"]')!;
  }

  it("renders nothing but the region when no control is configured", async () => {
    await render(<IndexFilters />);

    const bar = host.querySelector<HTMLElement>('[data-testid="index-filters"]')!;
    expect(bar.getAttribute("role")).toBe("search");
    expect(bar.children).toHaveLength(0);
  });

  it("reports search input and clears it", async () => {
    const onSearchChange = vi.fn();
    await render(<IndexFilters searchValue="" onSearchChange={onSearchChange} />);

    // The search field always has a label, even though it is visually hidden.
    expect(host.querySelector(`label[for="${search().id}"]`)!.textContent).toBe("Search");
    expect(host.querySelector('button[aria-label="Clear search"]')).toBeNull();

    await type(search(), "ayesha");
    expect(onSearchChange).toHaveBeenLastCalledWith("ayesha");

    await render(<IndexFilters searchValue="ayesha" onSearchChange={onSearchChange} />);
    const clear = host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
    await act(async () => clear.click());
    expect(onSearchChange).toHaveBeenLastCalledWith("");
  });

  it("waits for a pause before reporting a debounced search", async () => {
    vi.useFakeTimers();
    try {
      const onSearchChange = vi.fn();
      await render(
        <IndexFilters searchValue="" onSearchChange={onSearchChange} searchDebounceMs={350} />,
      );

      await type(search(), "clo");
      // The field keeps up with the operator even though nothing was reported.
      expect(search().value).toBe("clo");
      expect(onSearchChange).not.toHaveBeenCalled();

      await type(search(), "clog");
      await act(async () => {
        vi.advanceTimersByTime(349);
      });
      expect(onSearchChange).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      // Only the final value is reported, not every keystroke.
      expect(onSearchChange).toHaveBeenCalledTimes(1);
      expect(onSearchChange).toHaveBeenCalledWith("clog");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a debounced search immediately", async () => {
    vi.useFakeTimers();
    try {
      const onSearchChange = vi.fn();
      await render(
        <IndexFilters searchValue="" onSearchChange={onSearchChange} searchDebounceMs={350} />,
      );

      await type(search(), "clog");
      const clear = host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
      await act(async () => clear.click());

      expect(onSearchChange).toHaveBeenCalledTimes(1);
      expect(onSearchChange).toHaveBeenCalledWith("");
      expect(search().value).toBe("");

      // The cancelled keystrokes must not arrive after the clear.
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(onSearchChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts a search the caller changed itself", async () => {
    const onSearchChange = vi.fn();
    await render(
      <IndexFilters searchValue="clog" onSearchChange={onSearchChange} searchDebounceMs={350} />,
    );
    expect(search().value).toBe("clog");

    await render(
      <IndexFilters searchValue="" onSearchChange={onSearchChange} searchDebounceMs={350} />,
    );
    expect(search().value).toBe("");
    expect(onSearchChange).not.toHaveBeenCalled();
  });

  it("marks the active filter pill and reports pill changes", async () => {
    const onFilterChange = vi.fn();
    await render(
      <IndexFilters
        filters={[
          { id: "all", label: "All", count: 12 },
          { id: "open", label: "Open", count: 3 },
        ]}
        activeFilterId="all"
        onFilterChange={onFilterChange}
      />,
    );

    const all = host.querySelector<HTMLButtonElement>('[data-testid="index-filters-pill-all"]')!;
    const open = host.querySelector<HTMLButtonElement>('[data-testid="index-filters-pill-open"]')!;
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(open.getAttribute("aria-pressed")).toBe("false");
    expect(all.textContent).toContain("12");

    await act(async () => open.click());
    expect(onFilterChange).toHaveBeenCalledWith("open");
  });

  it("labels the sort control and keeps it out of the DOM without options", async () => {
    await render(<IndexFilters onSearchChange={vi.fn()} />);
    expect(host.querySelector('[data-testid="index-filters-sort"]')).toBeNull();

    await render(
      <IndexFilters
        onSearchChange={vi.fn()}
        sortValue="newest"
        sortOptions={[
          { value: "newest", label: "Newest first" },
          { value: "oldest", label: "Oldest first" },
        ]}
        onSortChange={vi.fn()}
      />,
    );

    const sort = host.querySelector<HTMLElement>('[data-testid="index-filters-sort"]')!;
    expect(sort.getAttribute("aria-label")).toBe("Sort by");
    expect(sort.textContent).toContain("Newest first");
  });

  it("renders extra actions supplied by the list", async () => {
    await render(<IndexFilters onSearchChange={vi.fn()} actions={<button type="button">Export</button>} />);
    expect(host.textContent).toContain("Export");
  });
});
