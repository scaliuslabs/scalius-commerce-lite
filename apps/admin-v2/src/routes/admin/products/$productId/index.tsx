import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProductView } from "~/components/admin/ProductView";
import { getProduct } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/products/$productId/")({
  loader: async ({ params }) => {
    const product = await getProduct({ data: { id: params.productId } }).catch(() => null) as any;
    if (!product) throw redirect({ to: "/admin/products" });
    return { product: product as any };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.product?.name || "Product"} | Scalius Admin` }],
  }),
  component: ProductViewPage,
});

function ProductViewPage() {
  const { product } = Route.useLoaderData();

  if (!product) {
    return <div>Product not found</div>;
  }

  return <ProductView product={product} />;
}
