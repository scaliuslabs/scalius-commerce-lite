/* eslint-disable shadcn/no-inline-styles, shadcn/no-unknown-classes -- the invoices are white paper documents (screen and
   print) that must not follow the dashboard theme, so they carry their own print stylesheet. */
import { createFileRoute, Link } from "@tanstack/react-router";
import { getApiV1AdminOrdersByIdInvoice } from "@scalius/api-client/sdk";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  INVOICE_CSS,
  InvoiceSheet,
  invoiceBusinessName,
  type InvoiceDocument,
} from "~/components/admin/orderview/InvoiceSheet";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { apiData } from "~/lib/api";
import { getAdminRouteContext } from "~/lib/admin-route-context";
import { pageHead } from "~/i18n/page-titles";

/** At most one list page of orders prints at once. */
const MAX_BULK_INVOICES = 90;
const PARALLEL_READS = 4;

/** `ids=a,b,c` → unique order ids, in order, capped. */
function parseInvoiceIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))].slice(0, MAX_BULK_INVOICES);
}

/** Reads invoices a few at a time, keeping the selection's order. */
async function loadInvoices(ids: readonly string[]): Promise<InvoiceDocument[]> {
  const documents: InvoiceDocument[] = [];
  for (let start = 0; start < ids.length; start += PARALLEL_READS) {
    const batch = ids.slice(start, start + PARALLEL_READS);
    documents.push(...await Promise.all(batch.map((id) => apiData(getApiV1AdminOrdersByIdInvoice({ path: { id } })))));
  }
  return documents;
}

export const Route = createFileRoute("/invoices")({
  validateSearch: (search: Record<string, unknown>) => ({ ids: parseInvoiceIds(search.ids).join(",") }),
  // Same sign-in gates as the admin shell; the invoice API enforces RBAC.
  beforeLoad: async () => {
    await getAdminRouteContext();
  },
  loaderDeps: ({ search }) => ({ ids: search.ids }),
  loader: ({ deps }) => loadInvoices(parseInvoiceIds(deps.ids)),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      ...pageHead("invoices").meta,
    ],
  }),
  errorComponent: InvoicesError,
  component: InvoicesPage,
});

function InvoicesPage() {
  const t = useMessages(orderDetailMessages);
  const documents = Route.useLoaderData();
  const businessNameMissing = documents.some((document) => !invoiceBusinessName(document));

  return (
    <div className="invoice-page">
      <style dangerouslySetInnerHTML={{ __html: INVOICE_CSS }} />
      <div className="sticky top-0 z-10 border-b bg-background print:hidden">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 p-3">
          <Button variant="ghost" asChild>
            <Link to="/admin/orders">{t("backToOrders")}</Link>
          </Button>
          <div className="flex items-center gap-2">
            <p className="text-body text-muted-foreground">{t("invoice.count", { count: documents.length })}</p>
            <Button onClick={() => window.print()} disabled={documents.length === 0}>{t("invoice.print")}</Button>
          </div>
          {businessNameMissing ? (
            <Alert variant="warning">
              <AlertDescription>
                {t("invoice.businessMissing")}{" "}
                <Link to="/admin/settings/store" className="text-link underline">{t("invoice.openSettings")}</Link>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </div>
      {documents.length === 0 ? (
        <p className="p-6 text-center text-body text-muted-foreground">{t("invoice.noneSelected")}</p>
      ) : (
        documents.map((document) => <InvoiceSheet key={document.order.id} document={document} />)
      )}
    </div>
  );
}

function InvoicesError({ error, reset }: { error: Error; reset: () => void }) {
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
