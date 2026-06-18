import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "~/components/admin/OrderForm";
import { productsQueryOptions } from "~/lib/api-query-options/products";
import type { Product } from "~/components/admin/order-form/types";
import { RouteErrorComponent } from "~/lib/route-error";

interface ProductListResult {
  products?: Array<{
    id: string;
    name: string;
    price: number;
    discountPercentage?: number | null;
    discountType?: "percentage" | "flat" | null;
    discountAmount?: number | null;
    variantCount?: number | null;
  }>;
}

const defaultValues = {
  customerName: "",
  customerPhone: "",
  customerEmail: null,
  shippingAddress: "",
  city: "",
  zone: "",
  area: null,
  notes: null,
  items: [],
  discountAmount: null,
  shippingCharge: 0,
};

function toOrderFormProduct(product: NonNullable<ProductListResult["products"]>[number]): Product {
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    discountPercentage: product.discountPercentage ?? null,
    discountType: product.discountType ?? null,
    discountAmount: product.discountAmount ?? null,
    variantCount: product.variantCount ?? 0,
    variants: [],
  };
}

export const Route = createFileRoute("/admin/orders/new")({
  loader: async ({ context: { queryClient } }) => {
    try {
      const result = await queryClient.ensureQueryData(
        productsQueryOptions({ page: 1, limit: 100 }),
      );
      const products = (result as ProductListResult).products || [];
      const productsWithVariants = products.map(toOrderFormProduct);
      return { productsWithVariants };
    } catch {
      return { productsWithVariants: [] };
    }
  },
  head: () => ({ meta: [{ title: "New Order | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: NewOrderPage,
});

function NewOrderPage() {
  const { productsWithVariants } = Route.useLoaderData();

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <OrderForm
        products={productsWithVariants}
        defaultValues={defaultValues}
        isEdit={false}
      />
    </div>
  );
}
