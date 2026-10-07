import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { cn } from "@scalius/shared/utils";
import { ResourceRowLink } from "~/components/admin/resource/ResourceListPage";
import { useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { customerTitle, type CustomerTitleInput } from "~/lib/customer-title";

/**
 * The customer column of the list: two lines on every row, each cut with the
 * whole value on hover. A guest record is titled by its phone and shows the
 * latest order's name as a hint; an account or a customer the merchant added
 * is titled by name with the phone (or email) below.
 */
export function CustomerCell({ customer, to }: { customer: CustomerTitleInput; to?: string }) {
  const t = useMessages(customersMessages);
  const { title, detail } = customerTitle(customer, t);
  const phone = customer.kind !== "guest" && customer.phone ? formatPhoneForDisplay(customer.phone) : null;
  const second = customer.kind === "guest" ? detail : phone ?? customer.email ?? null;
  return (
    <div className="min-h-[2lh] min-w-0">
      <ResourceRowLink to={to} lines={1} title={title}>{title}</ResourceRowLink>
      {second ? <span title={second} className={cn("block truncate text-muted-foreground", phone && "font-mono")}>{second}</span> : null}
    </div>
  );
}
