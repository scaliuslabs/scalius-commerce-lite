import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ProductView } from "~/components/admin/ProductView";
import { productQueryOptions } from "~/lib/api-query-options/products";
import type { ProductDetail } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/products/$productId/")({
  loader: async ({ params, context: { queryClient } }) => {
    const product = await queryClient.ensureQueryData({ ...productQueryOptions(params.productId), staleTime: Infinity }).catch(() => null);
    if (!product) throw redirect({ to: "/admin/products" });
  },
  head: () => ({
    meta: [{ title: "Product | Scalius Admin" }],
  }),
  errorComponent: RouteErrorComponent,
  component: ProductViewPage,
});

function ProductViewPage() {
  const { productId } = Route.useParams();
  const { data: productData } = useSuspenseQuery(productQueryOptions(productId));
  const product = productData as ProductDetail;

  // ProductView has its own inline product type — cast through unknown for compatibility
  return <ProductView product={product as unknown as React.ComponentProps<typeof ProductView>["product"]} />;
}
