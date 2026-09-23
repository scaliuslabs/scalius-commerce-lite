import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import type { OrderOperationalReadState } from "~/lib/order-operational-read-state";

/**
 * Loading, failed and stale states of a secondary order read. Actions that
 * depend on the read stay hidden by the caller until it is `ready`.
 */
export function OperationalReadNotice({
  read,
  label,
  onRetry,
}: {
  read: OrderOperationalReadState;
  /** What could not be loaded, e.g. "Couldn't load shipments." */
  label: string;
  onRetry: () => void;
}) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  if (read.status === "ready") return null;
  if (read.status === "loading") {
    return <p role="status" className="text-body text-muted-foreground">{t("read.loading")}</p>;
  }
  return (
    <div role="status" className="flex items-center justify-between gap-2 text-body">
      <p className="text-muted-foreground">{read.status === "stale" ? t("read.stale") : label}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={read.refreshing}>
        {r("retry")}
      </Button>
    </div>
  );
}
