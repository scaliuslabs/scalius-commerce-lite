import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
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

export const Route = createFileRoute("/admin/orders/$orderId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    const result = await queryClient.ensureQueryData({
      ...orderFormDataQueryOptions(params.orderId),
      staleTime: Infinity,
    });
    const locations = await queryClient.ensureQueryData(
      deliveryLocationsQueryOptions({ type: "city" }),
    );
    assertOrderFormLocationLookup(locations);
    return buildEditOrderFormRouteData(result);
  },
  head: ({ params }) => ({
    meta: [{ title: `Edit Order #${params.orderId} | Scalius Admin` }],
  }),
  errorComponent: EditOrderFormErrorComponent,
  component: EditOrderPage,
});

function EditOrderFormErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <OrderFormRouteError
      title="Order editor could not be loaded"
      description="Required order form, product, or delivery-location data is unavailable. The order was not changed."
      error={error}
      reset={reset}
    />
  );
}

function EditOrderPage() {
  const r = Route.useLoaderData();

  if (!r.fullEditReadiness.allowed) {
    return (
      <div className="container max-w-3xl py-6">
        <Card>
          <CardContent className="flex flex-col items-start gap-4 p-6 sm:p-8">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              <LockKeyhole className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold tracking-tight">Order contents are protected</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                {r.fullEditReadiness.reason ?? "This order can no longer be changed in the full editor."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link
                  to="/admin/orders/$orderId"
                  params={{ orderId: r.defaultValues.id as string }}
                >
                  View order
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/admin/orders">Back to orders</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const productsWithVariants = r.productsWithVariants.map((p) => ({
    ...p,
    variants: p.variants.map((v) => ({ ...v, sku: v.sku || "", price: v.price ?? 0 })),
  }));

  return (
    <div className="container max-w-7xl py-4 pb-8">
      <OrderForm
        products={productsWithVariants}
        defaultValues={r.defaultValues}
        isEdit={true}
      />
    </div>
  );
}
