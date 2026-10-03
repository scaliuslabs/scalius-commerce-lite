// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { badgeVariants } from "~/components/ui/badge";
import { RESOURCE_STATUS_VARIANT, StatusBadge } from "./StatusBadge";
import { ProductStatusBadge } from "../product-list/ProductStatusBadge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("one status badge for every record", () => {
  it("draws each state in DESIGN.md's colour", () => {
    expect(RESOURCE_STATUS_VARIANT).toEqual({
      active: "success",
      draft: "attention",
      scheduled: "info",
      expired: "destructive",
      error: "destructive",
      archived: "secondary",
      hidden: "secondary",
      inactive: "secondary",
    });
  });

  it("draws a product's Draft exactly like a page's, brand's or category's", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(
      <>
        <ProductStatusBadge isActive={false} />
        <StatusBadge status="draft">Draft</StatusBadge>
      </>,
    ));
    const [product, page] = [...host.querySelectorAll<HTMLElement>("span")].filter((element) => element.textContent === "Draft");
    expect(page?.className).toBe(badgeVariants({ variant: "attention" }));
    expect(product?.className).toBe(`${badgeVariants({ variant: "attention" })} shrink-0`);
    act(() => root.unmount());
  });
});
