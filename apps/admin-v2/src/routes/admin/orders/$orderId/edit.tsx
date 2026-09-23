import { createFileRoute, Link } from "@tanstack/react-router";
import { OrderForm } from "~/components/admin/OrderForm";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { orderFormDataQueryOptions } from "~/lib/api-query-options/orders";
import { deliveryLocationsQueryOptions } from "~/lib/api-query-options/delivery";
import { translate, useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { OrderFormRouteError } from "../-OrderFormRouteError";
import { orderEditMode } from "../-order-form-route-state";

export const Route = createFileRoute("/admin/orders/$orderId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    const [data] = await Promise.all([
      // Always fresh: the saved version and the edit rules must match the server.
      queryClient.fetchQuery({ ...orderFormDataQueryOptions(params.orderId), staleTime: 0 }),
      queryClient.ensureQueryData(deliveryLocationsQueryOptions({ type: "city" })),
    ]);
    return data;
  },
  head: ({ params }) => ({
    meta: [{ title: `${translate(orderFormMessages, "editOrder", { id: params.orderId })} | Scalius Admin` }],
  }),
  errorComponent: OrderFormRouteError,
  component: EditOrderPage,
});

function EditOrderPage() {
  const { orderId } = Route.useParams();
  const data = Route.useLoaderData();
  const t = useMessages(orderFormMessages);
  const edit = orderEditMode(data);

  if (edit.mode !== "locked") {
    return (
      <OrderForm
        mode={edit.mode}
        products={data.productsWithVariants}
        defaultValues={data.defaultValues}
      />
    );
  }

  return (
    <>
      <PageHeader title={t("editOrder", { id: orderId })} backTo={`/admin/orders/${orderId}`} />
      <Card>
        <CardHeader>
          <CardTitle>{t("locked")}</CardTitle>
          {edit.reason ? <CardDescription>{edit.reason}</CardDescription> : null}
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/admin/orders/$orderId" params={{ orderId }}>
              {t("backToOrder")}
            </Link>
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
