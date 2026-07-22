// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CustomerDeleteDialog } from "./-CustomerDeleteDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CustomerDeleteDialog", () => {
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

  it("confirms irreversible bulk deletion with mobile-sized actions", async () => {
    await act(async () => root.render(
      <CustomerDeleteDialog
        showTrashed
        customerCount={3}
        isOpen
        isActionLoading={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    ));

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "Permanently delete 3 customers?",
      );
    });
    expect(document.body.textContent).toContain("This cannot be undone.");
    for (const label of ["Cancel", "Delete permanently"]) {
      const button = Array.from(document.body.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      expect(button?.className).toContain("h-11");
    }
  });
});
