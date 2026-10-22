import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ProductBulkEditor } from "~/components/admin/product-list/ProductBulkEditor";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

// The selected products travel as ids only (never a search or a contact detail).
const searchSchema = z.object({ ids: z.string().max(4_000).optional() });

export const Route = createFileRoute("/admin/products/bulk-edit")({
  validateSearch: searchSchema,
  head: () => pageHead("bulkEditProducts"),
  errorComponent: RouteErrorComponent,
  component: BulkEditPage,
});

function BulkEditPage() {
  const { ids } = Route.useSearch();
  const list = (ids ?? "").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 50);
  return <ProductBulkEditor ids={list} />;
}
