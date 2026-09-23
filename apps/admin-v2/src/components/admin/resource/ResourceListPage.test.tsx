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
    expect(document.body.textContent).toContain("Move 1 to trash?");

    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find(
      (element) => element.textContent?.trim() === "Move to trash",
    ) as HTMLButtonElement;
    await act(async () => confirm.click());

    expect(run).toHaveBeenCalledWith("trash", [rows[0]]);
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
});
