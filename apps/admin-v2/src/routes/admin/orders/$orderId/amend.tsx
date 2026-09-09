import { createFileRoute, Link } from "@tanstack/react-router";
import { LockKeyhole } from "lucide-react";
import { OrderForm } from "~/components/admin/OrderForm";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { orderFormDataQueryOptions } from "~/lib/api-query-options/orders";
import { deliveryLocationsQueryOptions } from "~/lib/api-query-options/delivery";
import { OrderFormRouteError } from "../-OrderFormRouteError";
import {
  assertOrderFormLocationLookup,
  buildEditOrderFormRouteData,
} from "../-order-form-route-state";

export const Route = createFileRoute("/admin/orders/$orderId/amend")({
  loader: async ({ context: { queryClient }, params }) => {
    const result = await queryClient.ensureQueryData({
      ...orderFormDataQueryOptions(params.orderId),
      staleTime: 0,
    });
    const locations = await queryClient.ensureQueryData(
      deliveryLocationsQueryOptions({ type: "city" }),
    );
    assertOrderFormLocationLookup(locations);
    return buildEditOrderFormRouteData(result);
  },
  head: ({ params }) => ({
    meta: [{ title: `Amend Order #${params.orderId} | Scalius Admin` }],
  }),
  errorComponent: ({ error, reset }) => (
    <OrderFormRouteError
      title="Order amendment could not be loaded"
      description="Required order, product, or delivery-location data is unavailable. The order was not changed."
      error={error}
      reset={reset}
    />
  ),
  component: AmendOrderPage,
});

function AmendOrderPage() {
  const data = Route.useLoaderData();
  if (!data.amendmentReadiness.allowed) {
    return (
      <div className="container max-w-3xl py-6">
        <Card>
          <CardContent className="flex flex-col items-start gap-4 p-6 sm:p-8">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              <LockKeyhole className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold tracking-tight">Amendment unavailable</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                {data.amendmentReadiness.reason ?? "This order can no longer be amended."}
              </p>
            </div>
            <Button asChild>
              <Link
                to="/admin/orders/$orderId"
                params={{ orderId: data.defaultValues.id as string }}
              >
                View order
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const products = data.productsWithVariants.map((product) => ({
    ...product,
    variants: product.variants.map((variant) => ({
      ...variant,
      sku: variant.sku || "",
      price: variant.price ?? 0,
    })),
  }));
  return (
    <div className="container max-w-7xl py-4 pb-8">
      <OrderForm
        products={products}
        defaultValues={data.defaultValues}
        isEdit
        isAmend
      />
    </div>
  );
}
