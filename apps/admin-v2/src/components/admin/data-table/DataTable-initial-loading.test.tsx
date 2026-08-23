// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DataTableInitialCards,
  DataTableInitialRows,
} from "./DataTableInitialLoading";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("DataTable initial loading", () => {
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
  });

  it("renders table-shaped skeleton rows without a spinner", async () => {
    await act(async () => {
      root.render(
        <table>
          <tbody>
            <DataTableInitialRows columnCount={3} includeDragColumn={false} />
          </tbody>
        </table>,
      );
    });

    const loadingRows = host.querySelectorAll('[data-data-table-loading-row]');
    expect(loadingRows).toHaveLength(5);
    for (const row of loadingRows) {
      expect(row.querySelectorAll("td")).toHaveLength(3);
      expect(row.getAttribute("aria-hidden")).toBe("true");
    }
    expect(host.querySelector(".animate-spin")).toBeNull();
  });

  it("renders card-shaped skeletons on mobile", async () => {
    await act(async () => root.render(<DataTableInitialCards />));

    expect(host.querySelectorAll('[data-data-table-loading-card]')).toHaveLength(4);
    expect(host.querySelector(".animate-spin")).toBeNull();
  });

  it("preserves the drag-handle column for sortable tables", async () => {
    await act(async () => {
      root.render(
        <table>
          <tbody>
            <DataTableInitialRows columnCount={4} includeDragColumn />
          </tbody>
        </table>,
      );
    });

    const loadingRows = host.querySelectorAll('[data-data-table-loading-row]');
    expect(loadingRows).toHaveLength(5);
    for (const row of loadingRows) {
      expect(row.querySelectorAll("td")).toHaveLength(4);
      expect(row.querySelector("td")?.className).toContain("w-[40px]");
    }
  });
});
