import { createFileRoute, Link } from "@tanstack/react-router";
import { formatOrderNumber } from "@scalius/shared/order-utils";
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
import { orderFormDataQueryOptions, orderQueryOptions } from "~/lib/api-query-options/orders";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { OrderFormRouteError } from "../-OrderFormRouteError";
import { formItems, formProducts, orderEditState, savedDeliveryMethod } from "../-order-form-route-state";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/orders/$orderId/edit")({
  loader: async ({ context: { queryClient }, params }) => {
    const [data, order] = await Promise.all([
      // Always fresh: the saved version and the edit rules must match the server.
      queryClient.fetchQuery({ ...orderFormDataQueryOptions(params.orderId), staleTime: 0 }),
      // The cash still to collect, for the review's "before → after" line, and the delivery method.
      queryClient.ensureQueryData(orderQueryOptions(params.orderId)),
    ]);
    const { shippingMethodId, shippingMethodKind, savedShippingMethod } = savedDeliveryMethod(order);
    const products = formProducts(data.productsWithVariants);
    return {
      ...data,
      productsWithVariants: products,
      defaultValues: {
        ...data.defaultValues,
        shippingMethodId,
        shippingMethodKind,
        shippingAddress: data.defaultValues.shippingAddress ?? "",
        city: data.defaultValues.city ?? "",
        zone: data.defaultValues.zone ?? "",
        items: formItems(data.defaultValues.items, products),
      },
      savedShippingMethod,
      cashToCollect: order.balanceDue,
    };
  },
  head: ({ loaderData, params }) => pageHead("editOrder", {
    number: formatOrderNumber(loaderData?.order.orderNumber, params.orderId),
  }),
  errorComponent: OrderFormRouteError,
  component: EditOrderPage,
});

function EditOrderPage() {
  const { orderId } = Route.useParams();
  const data = Route.useLoaderData();
  const t = useMessages(orderFormMessages);
  const orderLabel = formatOrderNumber(data.order.orderNumber, orderId);
  const edit = orderEditState(data.editReadiness);

  if (edit.mode === "amend") {
    return (
      <OrderForm
        mode="amend"
        products={data.productsWithVariants}
        defaultValues={data.defaultValues}
        orderLabel={orderLabel}
        cashToCollect={data.cashToCollect}
        savedShippingMethod={data.savedShippingMethod}
      />
    );
  }

  return (
    <>
      <PageHeader title={t("editOrder", { number: orderLabel })} backTo={`/admin/orders/${orderId}`} />
      <Card>
        <CardHeader>
          <CardTitle>{t("lockedTitle")}</CardTitle>
          <CardDescription>{t(edit.message)}</CardDescription>
          {edit.canEditDetails ? <CardDescription>{t("detailsStillEditable")}</CardDescription> : null}
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
