// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceListPage, type ResourceLifecycle } from "./ResourceListPage";
import { readListSearch, useListSearch, writeListSearch } from "~/lib/list-search";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

interface Row {
  id: string;
  name: string;
  revision: number;
}

const rows: Row[] = [
  { id: "a", name: "Alpha", revision: 3 },
  { id: "b", name: "Beta", revision: 7 },
];

const search = { page: 1, limit: 10, search: "", sort: "name", order: "asc" as const, trashed: false };

describe("ResourceListPage", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  async function render(lifecycle?: ResourceLifecycle<Row>, trashed = false) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const query = {
      queryKey: ["things", trashed],
      queryFn: async () => ({ things: rows, pagination: { page: 1, limit: 10, total: 2, totalPages: 1 } }),
    };
    const rootRoute = createRootRoute();
    const listRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <ResourceListPage<Row>
          title="Things"
          list="things"
          search={{ ...search, trashed }}
          query={query}
          dataKey="things"
          columns={[{ accessorKey: "name", header: "Name", cell: ({ row }) => row.original.name }]}
          invalidate={[["things"]]}
          empty={{ icon: () => null, title: "Nothing", description: "" }}
          lifecycle={lifecycle}
        />
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([listRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const checkboxes = () => host.querySelectorAll('[role="checkbox"]');
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === text);

  it("offers no selection or trash when the viewer cannot change records", async () => {
    await render({ canTrash: false, canRestore: false, canDelete: false, run: vi.fn() });

    expect(host.textContent).toContain("Alpha");
    expect(checkboxes()).toHaveLength(0);
    expect(button("Move to trash")).toBeUndefined();
  });

  it("confirms before trashing and sends the selected rows with their revisions", async () => {
    const run = vi.fn(async () => undefined);
    await render({ canTrash: true, canRestore: true, canDelete: true, run });

    const [, first] = [...checkboxes()] as HTMLElement[];
    await act(async () => first!.click());
    await act(async () => button("Move to trash")!.click());
    expect(run).not.toHaveBeenCalled();
    // The confirmation loads the first time it is asked for.
    await vi.waitFor(() => expect(document.body.textContent).toContain("Move 1 to trash?"));

    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find(
      (element) => element.textContent?.trim() === "Move to trash",
    ) as HTMLButtonElement;
    await act(async () => confirm.click());

    expect(run).toHaveBeenCalledWith("trash", [rows[0]]);
  });

  it("offers Undo on the trash toast only when the list opts in, and Undo restores the same rows", async () => {
    const { toast } = await import("sonner");
    const trashFirst = async (lifecycle: ResourceLifecycle<Row>) => {
      vi.mocked(toast.success).mockClear();
      await render(lifecycle);
      const [, first] = [...checkboxes()] as HTMLElement[];
      await act(async () => first!.click());
      await act(async () => button("Move to trash")!.click());
      const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find(
        (element) => element.textContent?.trim() === "Move to trash",
      ) as HTMLButtonElement;
      await act(async () => confirm.click());
      return vi.mocked(toast.success).mock.calls.at(-1);
    };

    const plain = await trashFirst({ canTrash: true, canRestore: true, canDelete: true, run: vi.fn(async () => undefined) });
    expect(plain).toEqual(["Moved to trash"]);
    act(() => root.unmount());
    root = createRoot(host);

    const run = vi.fn(async () => undefined);
    const call = await trashFirst({ canTrash: true, canRestore: true, canDelete: true, undoTrash: true, run });
    const options = call?.[1] as { action: { label: string; onClick: () => void } };
    expect(call?.[0]).toBe("Moved to trash");
    expect(options.action.label).toBe("Undo");
    await act(async () => options.action.onClick());
    expect(run).toHaveBeenLastCalledWith("restore", [rows[0]]);
  });

  it("restores from Trash without a confirmation but never offers trash there", async () => {
    const run = vi.fn(async () => undefined);
    await render({ canTrash: true, canRestore: true, canDelete: false, run }, true);

    const [, first] = [...checkboxes()] as HTMLElement[];
    await act(async () => first!.click());
    expect(button("Move to trash")).toBeUndefined();
    expect(button("Delete permanently")).toBeUndefined();
    await act(async () => button("Restore")!.click());

    expect(run).toHaveBeenCalledWith("restore", [rows[0]]);
  });

  describe("cursor paging", () => {
    const pageInfo = { hasNextPage: true, hasPreviousPage: false, startCursor: "start-1", endCursor: "end-1" };

    async function renderCursorList(overrides: Record<string, string> = {}, error?: { code: string }) {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const query = {
        queryKey: ["cursor-things", JSON.stringify(overrides)],
        queryFn: async () => {
          if (error) throw Object.assign(new Error("refused"), error);
          return {
            things: rows,
            pagination: { page: 1, limit: 10, total: 1_000, totalPages: 100, totalIsCapped: true, offset: 0 },
            pageInfo,
          };
        },
      };
      const rootRoute = createRootRoute();
      const listRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        validateSearch: (raw: Record<string, unknown>) => raw,
        component: function CursorList() {
          const current = listRoute.useSearch() as Record<string, unknown>;
          return (
            <ResourceListPage<Row>
              title="Things"
              list="cursor-things"
              search={{ ...search, ...current } as typeof search}
              query={query}
              dataKey="things"
              columns={[{ accessorKey: "name", header: "Name", cell: ({ row }) => row.original.name }]}
              invalidate={[["cursor-things"]]}
              empty={{ icon: () => null, title: "Nothing", description: "" }}
              cursorPaging
            />
          );
        },
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([listRoute]),
        history: createMemoryHistory({ initialEntries: [`/?${new URLSearchParams(overrides)}`] }),
      });
      await router.load();
      await act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>,
        ),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return router;
    }

    const arrow = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

    it("shows an approximate count and moves to the next page with the end cursor", async () => {
      const router = await renderCursorList();
      expect(host.textContent).toContain("1–2 of 1,000+");
      expect(arrow("Previous").disabled).toBe(true);
      await act(async () => arrow("Next").click());
      expect(router.state.location.search).toMatchObject({ after: "end-1", page: 1 });
      expect(router.state.location.search).not.toHaveProperty("before");
    });

    it("keeps a cursor in the URL while the API has no previous page to offer", async () => {
      const router = await renderCursorList({ after: "end-0" });
      expect(arrow("Previous").disabled).toBe(true);
      expect(router.state.location.search).toMatchObject({ after: "end-0" });
    });

    it("starts again from the first page when the API refuses the cursor", async () => {
      const router = await renderCursorList({ after: "stale-cursor" }, { code: "invalid_cursor" });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(router.state.location.search).not.toHaveProperty("after");
      expect(router.state.location.search).toMatchObject({ page: 1 });
    });

    async function renderSearchRace(position: "before" | "after" | "page", empty = false) {
      const list = "cursor-search-regression";
      writeListSearch(list, "old");
      const requests: Array<{ term: string; before?: unknown; after?: unknown; page?: unknown }> = [];
      const resetStarted = vi.fn();
      let releaseReset!: () => void;
      const reset = new Promise<void>((resolve) => { releaseReset = resolve; });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      const rootRoute = createRootRoute();
      const listRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        validateSearch: (raw: Record<string, unknown>) => ({ ...raw, page: Number(raw.page ?? 1) }),
        loaderDeps: ({ search: current }) => current,
        loader: async ({ deps }) => {
          const current = deps as Record<string, unknown>;
          if (!current.before && !current.after && current.page === 1) {
            resetStarted();
            await reset;
          }
        },
        component: function SearchingList() {
          const current = listRoute.useSearch() as Record<string, unknown>;
          const [term] = useListSearch(list);
          return (
            <ResourceListPage<Row>
              title="Things"
              list={list}
              search={{ ...search, ...current } as typeof search}
              query={{
                queryKey: [list, current, term],
                queryFn: async () => {
                  requests.push({ term, before: current.before, after: current.after, page: current.page });
                  return {
                    things: empty && term ? [] : rows,
                    pagination: { page: 1, limit: 10, total: 2, totalPages: 1 },
                    pageInfo,
                  };
                },
              }}
              dataKey="things"
              columns={[{ accessorKey: "name", header: "Name" }]}
              invalidate={[[list]]}
              filterParams={["category"]}
              empty={{ icon: () => null, title: "Nothing", description: "" }}
              cursorPaging
            />
          );
        },
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([listRoute]),
        history: createMemoryHistory({ initialEntries: [`/?${position}=${position === "page" ? "5" : "old-cursor"}&category=old-category`] }),
      });
      await router.load();
      await act(async () => root.render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>));
      await vi.waitFor(() => expect(host.querySelector("input")).not.toBeNull());
      return { list, requests, resetStarted, releaseReset, router };
    }

    const typeSearch = async (value: string) => {
      const input = host.querySelector<HTMLInputElement>("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    it.each(["before", "after", "page"] as const)("drops the %s position before publishing a changed search term", async (position) => {
      const state = await renderSearchRace(position);
      await typeSearch("new term");
      await vi.waitFor(() => expect(state.resetStarted).toHaveBeenCalled());
      expect(readListSearch(state.list)).toBe("old");
      await act(async () => state.releaseReset());
      await vi.waitFor(() => expect(state.requests.some((request) => request.term === "new term")).toBe(true));
      expect(state.requests.filter((request) => request.term !== "old")).toEqual([
        { term: "new term", before: undefined, after: undefined, page: 1 },
      ]);
      expect(state.router.state.location.search).not.toHaveProperty("q");
      expect(state.router.state.location.href).not.toContain("new");
    });

    it.each(["", "latest"])("lets the latest search value %j supersede a search waiting for its cursor reset", async (latest) => {
      const state = await renderSearchRace("before");
      await typeSearch("superseded");
      await vi.waitFor(() => expect(state.resetStarted).toHaveBeenCalled());
      if (latest) {
        await typeSearch(latest);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
      } else {
        await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click());
      }
      expect(readListSearch(state.list)).toBe("old");
      await act(async () => state.releaseReset());
      await vi.waitFor(() => expect(readListSearch(state.list)).toBe(latest));
      expect(state.requests.some((request) => request.term === "superseded")).toBe(false);
      expect(state.requests.filter((request) => request.term === latest).every((request) => !request.before && !request.after && request.page === 1)).toBe(true);
      expect(host.querySelector<HTMLInputElement>("input")!.value).toBe(latest);
    });

    it("resets paging and filters before the empty state's Clear filters clears the term", async () => {
      const state = await renderSearchRace("before", true);
      await vi.waitFor(() => expect(button("Clear filters")).toBeDefined());
      await typeSearch("superseded draft");
      await act(async () => button("Clear filters")!.click());
      await vi.waitFor(() => expect(state.resetStarted).toHaveBeenCalled());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
      expect(readListSearch(state.list)).toBe("old");
      expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
      await act(async () => state.releaseReset());
      await vi.waitFor(() => expect(readListSearch(state.list)).toBe(""));
      expect(state.requests.some((request) => request.term === "superseded draft")).toBe(false);
      expect(state.requests.filter((request) => request.term === "").every((request) => !request.before && !request.after && request.page === 1)).toBe(true);
      expect(state.router.state.location.search).not.toHaveProperty("category");
      expect(state.router.state.location.search).not.toHaveProperty("q");
    });
  });
});
