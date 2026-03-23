import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "~/components/admin/OrderForm";
import { getProducts, getProduct } from "~/lib/api.functions";

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

export const Route = createFileRoute("/admin/orders/new")({
  loader: async () => {
    try {
      const result = await getProducts({ data: { page: 1, limit: 100 } });
      const products = (result as any).products || [];
      const BATCH_SIZE = 10;
      const productsWithVariants: any[] = [];
      for (let i = 0; i < products.length; i += BATCH_SIZE) {
        const batch = products.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (p: any) => {
            try {
              const detail = await getProduct({ data: { id: p.id } });
              const d = detail as any;
              return {
                id: p.id,
                name: p.name,
                price: p.price,
                discountPercentage: p.discountPercentage ?? null,
                variants: (d.variants || [])
                  .filter((v: any) => !v.deletedAt)
                  .map((v: any) => ({
                    id: v.id,
                    size: v.size,
                    color: v.color,
                    weight: typeof v.weight === "string" ? parseFloat(v.weight) || null : (v.weight ?? null),
                    sku: v.sku || "",
                    price: v.price ?? 0,
                    stock: v.stock ?? 0,
                  })),
              };
            } catch {
              return { id: p.id, name: p.name, price: p.price, discountPercentage: p.discountPercentage ?? null, variants: [] };
            }
          }),
        );
        productsWithVariants.push(...batchResults);
      }
      return { productsWithVariants };
    } catch {
      return { productsWithVariants: [] };
    }
  },
  head: () => ({ meta: [{ title: "New Order | Scalius Admin" }] }),
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
