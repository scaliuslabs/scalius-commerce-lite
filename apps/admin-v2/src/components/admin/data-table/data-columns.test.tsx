// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { dataColumns, type DataColumnSpec } from "./data-columns";
import type { ColumnDef } from "./table-config";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Two decimal places, as the store's currency code sets them.
vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ code: "BDT", fmt: (amount: number) => `৳${amount.toFixed(2)}` }),
}));

type Row = { id: string; value: unknown };

function cell(spec: Omit<DataColumnSpec<Row>, "id" | "label" | "value">, value: unknown): ReactNode {
  const [column] = dataColumns<Row>([{ id: "app.test", label: "Test", value: (row) => row.value, ...spec }]) as [ColumnDef<Row, unknown>];
  const render = column.cell as (context: { row: { original: Row } }) => ReactNode;
  return render({ row: { original: { id: "r1", value } } });
}

describe("data columns", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setLocale("en");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setLocale("en");
  });

  const show = (spec: Omit<DataColumnSpec<Row>, "id" | "label" | "value">, value: unknown) => {
    act(() => root.render(<>{cell(spec, value)}</>));
    return container.textContent;
  };

  it("writes money in the store currency (major units, as the API sends every amount)", () => {
    expect(show({ kind: "money" }, 12.5)).toBe("৳12.50");
    expect(show({ kind: "money" }, 0)).toBe("৳0.00");
  });

  it("shows a yes/no value as a Yes or No badge", () => {
    expect(show({ kind: "boolean" }, true)).toBe("Yes");
    expect(show({ kind: "boolean" }, false)).toBe("No");
    setLocale("bn");
    expect(show({ kind: "boolean" }, true)).toBe("হ্যাঁ");
    expect(show({ kind: "boolean" }, false)).toBe("না");
  });

  it("reads an empty cell as a dash, for every kind", () => {
    for (const kind of ["text", "number", "money", "date", "boolean"] as const) {
      expect(show({ kind }, null), kind).toBe("—");
    }
    expect(show({ kind: "text" }, "")).toBe("—");
  });

  it("writes text and numbers as they are", () => {
    expect(show({ kind: "text" }, "Gold")).toBe("Gold");
    expect(show({ kind: "number" }, 1234)).toBe("1,234");
  });

  it("keeps a boolean column within its width and right of the list's working columns in priority", () => {
    const [column] = dataColumns<Row>([{ id: "app.test", label: "Active", kind: "boolean", priority: 99, value: () => true }]);
    expect(column?.meta).toMatchObject({ maxWidth: 72, minWidth: 84, priority: 35, numeric: false });
  });
});
