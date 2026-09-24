import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { ResourceRowLink } from "~/components/admin/resource/ResourceListPage";
import { useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { customerTitle, type CustomerTitleInput } from "~/lib/customer-title";

/**
 * The customer column of the list. A guest record is titled by its phone and
 * shows the latest order's name as a hint; an account or a customer the
 * merchant added is titled by name with the phone below.
 */
export function CustomerCell({ customer, to }: { customer: CustomerTitleInput; to?: string }) {
  const t = useMessages(customersMessages);
  const { title, detail } = customerTitle(customer, t);
  return (
    <div className="min-w-0">
      <ResourceRowLink to={to}>{title}</ResourceRowLink>
      {customer.kind === "guest" ? (
        detail ? <span className="block truncate text-muted-foreground">{detail}</span> : null
      ) : (
        <span className="block truncate whitespace-nowrap font-mono text-muted-foreground">{formatPhoneForDisplay(customer.phone)}</span>
      )}
    </div>
  );
}
