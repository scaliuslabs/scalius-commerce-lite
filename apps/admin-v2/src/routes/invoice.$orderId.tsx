/* eslint-disable shadcn/no-inline-styles, shadcn/no-unknown-classes -- the invoice is a
   white paper document (screen and print) that must not follow the dashboard theme, so it
   carries its own print stylesheet and class names. */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { getApiV1AdminOrdersByIdInvoice } from "@scalius/api-client/sdk";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { Button } from "~/components/ui/button";
import { InvoiceActions } from "~/components/admin/InvoiceActions";
import {
  INVOICE_CSS,
  InvoiceSheet,
  invoiceBusinessName,
  type InvoiceDocument,
} from "~/components/admin/orderview/InvoiceSheet";
import { translate, useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { apiData } from "~/lib/api";
import { getAdminRouteContext } from "~/lib/admin-route-context";
import { pageTitleMessages } from "~/i18n/page-titles";

export const Route = createFileRoute("/invoice/$orderId")({
  // Same sign-in gates as the admin shell; the invoice API enforces RBAC.
  beforeLoad: async () => {
    await getAdminRouteContext();
  },
  loader: ({ params }): Promise<InvoiceDocument> =>
    apiData(getApiV1AdminOrdersByIdInvoice({ path: { id: params.orderId } })),
  head: ({ loaderData }) => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: loaderData
          ? `${translate(pageTitleMessages, "invoice")} ${formatOrderNumber(loaderData.order.orderNumber, loaderData.order.id)} · Scalius`
          : `${translate(pageTitleMessages, "invoice")} · Scalius`,
      },
    ],
  }),
  errorComponent: InvoiceError,
  component: InvoicePage,
});

function InvoicePage() {
  const [document, setDocument] = useState<InvoiceDocument>(Route.useLoaderData());

  return (
    <div className="invoice-page">
      <style dangerouslySetInnerHTML={{ __html: INVOICE_CSS }} />
      <InvoiceActions
        orderId={document.order.id}
        issued={document.status === "issued"}
        businessNameMissing={!invoiceBusinessName(document)}
        expectedOrderVersion={document.orderVersion}
        onIssued={setDocument}
      />
      <InvoiceSheet document={document} />
    </div>
  );
}

function InvoiceError({ error, reset }: { error: Error; reset: () => void }) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-heading-lg font-semibold">{t("invoice.loadFailed")}</h1>
      {error.message ? <p className="text-body text-muted-foreground">{error.message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={reset}>{r("retry")}</Button>
        <Button variant="outline" asChild>
          <Link to="/admin/orders">{t("backToOrders")}</Link>
        </Button>
      </div>
    </main>
  );
}
