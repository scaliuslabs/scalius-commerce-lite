// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "~/lib/query-keys";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { ProductPager } from "./ProductPager";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params, ...props }: { children: React.ReactNode; params: { productId: string } }) => (
    <a href={`/admin/products/${params.productId}/edit`} {...props}>{children}</a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const page = (ids: string[]) => ({ products: ids.map((id) => ({ id })), pagination: { page: 1, limit: 10, total: ids.length, totalPages: 1 } });

describe("ProductPager", () => {
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

  async function render(client: QueryClient, productId: string) {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <ProductPager productId={productId} />
      </QueryClientProvider>,
    ));
  }

  const button = (key: "previousProduct" | "nextProduct") =>
    host.querySelector(`[aria-label="${translate(productMessages, key)}"]`);

  it("is hidden when no products list is cached", async () => {
    await render(new QueryClient(), "prod_b");
    expect(host.innerHTML).toBe("");
  });

  it("links to the neighbours in the most recently loaded list", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.products.list({ page: 2 }), page(["prod_x", "prod_b", "prod_y"]), { updatedAt: 1 });
    client.setQueryData(queryKeys.products.list({ page: 1 }), page(["prod_a", "prod_b", "prod_c"]), { updatedAt: 2 });
    await render(client, "prod_b");

    expect(button("previousProduct")?.getAttribute("href")).toBe("/admin/products/prod_a/edit");
    expect(button("nextProduct")?.getAttribute("href")).toBe("/admin/products/prod_c/edit");
  });

  it("disables the arrow past either end of the list", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.products.list({ page: 1 }), page(["prod_a", "prod_b"]));
    await render(client, "prod_a");

    expect(button("previousProduct")?.hasAttribute("disabled")).toBe(true);
    expect(button("nextProduct")?.getAttribute("href")).toBe("/admin/products/prod_b/edit");
  });
});
