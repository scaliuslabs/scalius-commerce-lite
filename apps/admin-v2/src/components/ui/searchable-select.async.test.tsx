// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchableSelect, type SearchableSelectLoader, type SearchableSelectOption } from "./searchable-select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const THANAS: SearchableSelectOption[] = Array.from({ length: 5 }, (_, index) => ({
  value: `z${index + 1}`,
  label: `Mirpur-${index + 1}`,
  description: "Dhaka",
}));

/** Two options a page, filtered by the search. */
function pagedLoader(source = THANAS) {
  return vi.fn<SearchableSelectLoader>(async ({ search, page }) => {
    const matches = source.filter((option) => option.label.toLowerCase().includes(search.toLowerCase()));
    return { options: matches.slice((page - 1) * 2, page * 2), hasMore: page * 2 < matches.length };
  });
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(target: HTMLElement, name: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

describe("SearchableSelect with a server source", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  const trigger = () => host.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
  const search = () => document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const optionLabels = () =>
    [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].map((node) => node.textContent?.trim());
  const buttonNamed = (name: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === name);
  const render = (element: React.ReactElement) =>
    act(async () => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
  const open = async () => {
    await act(async () => trigger().click());
    await settle();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
  });

  it("loads nothing until opened, then searches on the server after a pause, never in the page URL", async () => {
    const load = pagedLoader();
    const url = window.location.href;
    await render(<SearchableSelect value="" onValueChange={vi.fn()} load={load} queryKey={["thanas"]} ariaLabel="Thana" />);
    expect(load).not.toHaveBeenCalled();

    await open();
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ search: "", page: 1 }));
    expect(optionLabels()).toEqual(["Mirpur-1 · Dhaka", "Mirpur-2 · Dhaka"]);

    await act(async () => type(search(), "  mirpur-4 "));
    await wait(300);
    await settle();
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ search: "mirpur-4", page: 1 }));
    expect(optionLabels()).toEqual(["Mirpur-4 · Dhaka"]);
    expect(window.location.href).toBe(url);
  });

  it("pages with Load more and on scrolling near the end", async () => {
    const load = pagedLoader();
    await render(<SearchableSelect value="" onValueChange={vi.fn()} load={load} queryKey={["thanas"]} />);
    await open();
    expect(optionLabels()).toHaveLength(2);

    await act(async () => buttonNamed("Load more")!.click());
    await settle();
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(optionLabels()).toHaveLength(4);

    const list = document.body.querySelector<HTMLElement>('[role="listbox"]')!;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 240 },
      scrollTop: { configurable: true, value: 150 },
    });
    await act(async () => list.dispatchEvent(new Event("scroll", { bubbles: true })));
    await settle();
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 }));
    expect(optionLabels()).toHaveLength(5);
    // The last page: nothing more to load.
    expect(buttonNamed("Load more")).toBeUndefined();
  });

  it("moves with the arrow keys, loads the next page past the end, and picks with Enter", async () => {
    const load = pagedLoader();
    const onValueChange = vi.fn();
    await render(<SearchableSelect value="" onValueChange={onValueChange} load={load} queryKey={["thanas"]} />);
    await open();
    const input = search();
    expect(input.getAttribute("aria-activedescendant")).toMatch(/option-0$/);

    await act(async () => key(input, "ArrowDown"));
    expect(input.getAttribute("aria-activedescendant")).toMatch(/option-1$/);
    // Past the last loaded option: the next page loads.
    await act(async () => key(input, "ArrowDown"));
    await settle();
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    await act(async () => key(input, "ArrowDown"));
    expect(input.getAttribute("aria-activedescendant")).toMatch(/option-2$/);

    await act(async () => key(input, "Enter"));
    expect(onValueChange).toHaveBeenCalledWith("z3", expect.objectContaining({ label: "Mirpur-3" }));
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    // Controlled: once the caller stores the value, the field shows the pick without a label of its own.
    await render(<SearchableSelect value="z3" onValueChange={onValueChange} load={load} queryKey={["thanas"]} />);
    expect(trigger().textContent).toContain("Mirpur-3");
  });

  it("labels a saved value that is not loaded, and clears it", async () => {
    const onValueChange = vi.fn();
    await render(
      <SearchableSelect
        value="z9"
        selectedLabel="Uttara"
        clearable
        ariaLabel="Thana"
        onValueChange={onValueChange}
        load={pagedLoader()}
        queryKey={["thanas"]}
      />,
    );
    expect(trigger().textContent).toContain("Uttara");
    const clear = host.querySelector<HTMLButtonElement>('button[aria-label="Clear Uttara"]')!;
    await act(async () => clear.click());
    expect(onValueChange).toHaveBeenCalledWith("", null);
  });

  it("shows loading, then an error with a retry, then an empty state", async () => {
    let fail = true;
    let release: () => void = () => {};
    const load = vi.fn<SearchableSelectLoader>(() => new Promise((resolve, reject) => {
      release = () => (fail ? reject(new Error("offline")) : resolve({ options: [], hasMore: false }));
    }));
    await render(<SearchableSelect value="" onValueChange={vi.fn()} load={load} queryKey={["thanas"]} emptyMessage="No thanas match." />);
    await act(async () => trigger().click());
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain("Loading…");
    expect(document.body.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");

    await act(async () => release());
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load the list.");

    fail = false;
    await act(async () => buttonNamed("Try again")!.click());
    await act(async () => release());
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("No thanas match.");
  });

  it("groups options under headings", async () => {
    const load = vi.fn<SearchableSelectLoader>(async () => ({
      hasMore: false,
      options: [
        { value: "c1", label: "Dhaka", group: "Cities" },
        { value: "z1", label: "Mirpur", group: "Thanas", description: "Dhaka" },
        { value: "z2", label: "Uttara", group: "Thanas", description: "Dhaka" },
      ],
    }));
    await render(<SearchableSelect value="" onValueChange={vi.fn()} load={load} queryKey={["places"]} />);
    await open();
    const listText = document.body.querySelector('[role="listbox"]')!.textContent;
    expect(listText).toBe("CitiesDhakaThanasMirpur · DhakaUttara · Dhaka");
  });
});
