import { cn } from "@scalius/shared/utils";
import { ResourceRowLink } from "~/components/admin/resource/ResourceListPage";
import { useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { customerTitle, type CustomerTitleInput } from "~/lib/customer-title";

/**
 * The customer column of the list: two lines on every row, each cut with the
 * whole value on hover. The name is first and the phone (or email) under it;
 * a guest record is named by the buyer on its latest order, and by its phone
 * only when that name is gone.
 */
export function CustomerCell({ customer, to }: { customer: CustomerTitleInput; to?: string }) {
  const t = useMessages(customersMessages);
  const { title, detail, detailIsPhone } = customerTitle(customer, t);
  return (
    <div className="min-h-[2lh] min-w-0">
      <ResourceRowLink to={to} lines={1} title={title}>{title}</ResourceRowLink>
      {detail ? <span title={detail} className={cn("block truncate text-muted-foreground", detailIsPhone && "font-mono")}>{detail}</span> : null}
    </div>
  );
}
