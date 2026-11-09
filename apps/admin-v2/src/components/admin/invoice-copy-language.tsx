// Which language a printed invoice speaks: the buyer's copy prints in the
// order's language (`buyerLanguage`, as the buyer's emails speak it), a staff
// copy in the staff member's. The packing slip goes in the parcel, so it is
// the buyer's too.
import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { LOCALES, useMessages, type Locale } from "~/i18n";
import { orderInvoiceMessages } from "~/i18n/order-invoice";

/** The language a sheet prints in. */
export function invoiceLanguage(buyerLanguage: Locale, staffCopy: boolean, dashboard: Locale): Locale {
  return staffCopy ? dashboard : buyerLanguage;
}

const languageName = (locale: Locale) => LOCALES.find((entry) => entry.value === locale)?.label ?? locale;

/**
 * The link to the other copy, when the buyer reads another language than the
 * staff member: "Staff copy (English)" on a buyer's copy, "Buyer's copy (বাংলা)" on a staff copy.
 */
export function InvoiceCopyToggle({ staffCopy, buyerLanguages, dashboard, search }: {
  staffCopy: boolean;
  buyerLanguages: readonly Locale[];
  dashboard: Locale;
  /** The route's other search params, kept on the link. */
  search: Record<string, string>;
}) {
  const t = useMessages(orderInvoiceMessages);
  const others = buyerLanguages.filter((language) => language !== dashboard);
  if (others.length === 0) return null;
  const label = staffCopy
    ? t("invoice.buyerCopy", { language: [...new Set(others)].map(languageName).join(", ") })
    : t("invoice.staffCopy", { language: languageName(dashboard) });
  return (
    <Button variant="outline" asChild>
      <Link to="." search={staffCopy ? search : { ...search, copy: "staff" }}>{label}</Link>
    </Button>
  );
}
