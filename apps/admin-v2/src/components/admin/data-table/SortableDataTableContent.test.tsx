// @vitest-environment happy-dom

import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocale } from "~/i18n";
import { SortableDataTableContent } from "./SortableDataTableContent";
import { type ColumnDef, serverTableFeatures, useTable } from "./table-config";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Collection {
  id: string;
  name: string;
}

const collections: Collection[] = [
  { id: "c1", name: "Eid picks" },
  { id: "c2", name: "Winter tees" },
];

function Harness({ labelled }: { labelled: boolean }) {
  const columns = useMemo<ColumnDef<Collection, unknown>[]>(() => [{ id: "name", accessorKey: "name" }], []);
  const table = useTable({
    features: serverTableFeatures,
    data: collections,
    columns,
    getRowId: (row) => row.id,
    state: { pagination: { pageIndex: 0, pageSize: 10 } },
  });
  return (
    <SortableDataTableContent
      table={table}
      columns={table.getVisibleLeafColumns()}
      rows={table.getRowModel().rows}
      hasRows
      showInitialLoading={false}
      onReorder={() => {}}
      getRowLabel={labelled ? (row) => row.name : undefined}
    />
  );
}

describe("SortableDataTableContent reorder handles (A11Y-02)", () => {
  let host: HTMLDivElement;
  let root: Root;
  const handleNames = () =>
    [...host.querySelectorAll('[aria-roledescription="sortable"]')].map((handle) => handle.getAttribute("aria-label"));

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    act(() => setLocale("en"));
  });

  it("names each grip after its row, in the dashboard's language", async () => {
    await act(async () => root.render(<Harness labelled />));
    expect(handleNames()).toEqual(["Reorder Eid picks", "Reorder Winter tees"]);

    await act(async () => setLocale("bn"));
    expect(handleNames()).toEqual(["Eid picks এর ক্রম বদলান", "Winter tees এর ক্রম বদলান"]);
  });

  it("numbers the grips when the list has no row names", async () => {
    await act(async () => root.render(<Harness labelled={false} />));
    expect(handleNames()).toEqual(["Reorder row 1", "Reorder row 2"]);
  });
});
