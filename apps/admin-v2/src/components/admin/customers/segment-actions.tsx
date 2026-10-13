// What the segments list and a segment's page share: member counts on request,
// the CSV export of a segment and the delete confirmation.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import { RefreshCw } from "lucide-react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { getServerFnError } from "~/lib/api-helpers";
import { deleteCustomerSegment } from "~/lib/api-mutations/customers";
import { customerSegmentCountQueryOptions } from "~/lib/api-query-options/customers";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { customerSegmentMessages, type CustomerSegmentMessageKey } from "~/i18n/customer-segments";
import { resourceMessages } from "~/i18n/resource";
import { buildCustomerExportParams, CUSTOMER_EXPORT_MAX_ROWS, downloadCustomerExport } from "./customer-export";

type Translate = (key: CustomerSegmentMessageKey, vars?: Record<string, string | number>) => string;

/** "1,234 customers", "1 customer", "1,00,000+ customers". */
export function segmentMembersLabel(t: Translate, count: { count: number; capped: boolean }): string {
  if (count.capped) return t("membersCapped", { count: count.count });
  return count.count === 1 ? t("membersOne") : t("members", { count: count.count });
}

/** Counting live members can scan a large audience: never do it on list mount. */
export function SegmentMemberCount({ segmentId, name }: { segmentId: string; name: string }) {
  const t = useMessages(customerSegmentMessages);
  const count = useQuery({ ...customerSegmentCountQueryOptions(segmentId), enabled: false });
  const label = t(count.isError ? "retryCountFor" : count.data ? "refreshCountFor" : "countFor", { name });
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1" aria-live="polite" aria-busy={count.isFetching}>
      {count.data ? <span className="tabular-nums">{segmentMembersLabel(t, count.data)}</span> : null}
      {count.isError ? <span className="text-muted-foreground">{t("countFailed")}</span> : null}
      <Button variant="ghost" size={count.data || count.isError ? "icon-sm" : "sm"}
        aria-label={label} title={label} loading={count.isFetching} onClick={() => void count.refetch({ cancelRefetch: false })}>
        {count.data || count.isError ? <RefreshCw aria-hidden="true" /> : t("count")}
      </Button>
    </span>
  );
}

/** Downloads a segment's customers as CSV (up to the export cap). */
export function useSegmentExport() {
  const t = useMessages(customerSegmentMessages);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (segmentId: string) => {
    if (busy) return;
    setBusy(segmentId);
    try {
      const { limited } = await downloadCustomerExport(buildCustomerExportParams({ filters: { segmentId }, ids: null }));
      toast.success(t("exported"), limited ? { description: t("exportedCapped", { count: CUSTOMER_EXPORT_MAX_ROWS }) } : undefined);
    } catch {
      toast.error(t("exportFailed"));
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/**
 * "Delete 'Big spenders'?" A segment a discount is limited to is refused by
 * the server (409); its message is shown and the segment stays.
 */
export function DeleteSegmentDialog({
  segment,
  onOpenChange,
  onDeleted,
}: {
  segment: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const t = useMessages(customerSegmentMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  // The name stays in the title while the dialog closes.
  const [shown, setShown] = useState(segment);
  if (segment && segment !== shown) setShown(segment);
  const remove = useMutation({
    mutationFn: (id: string) => deleteCustomerSegment(id),
    onSuccess: () => {
      toast.success(t("deleted"));
      onOpenChange(false);
      onDeleted?.();
    },
    onError: (error) => {
      toast.error(getServerFnError(error, r("actionFailed")));
      onOpenChange(false);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.segments() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
    },
  });
  return (
    <ConfirmDialog
      open={segment !== null}
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onOpenChange(false);
      }}
      title={t("deleteTitle", { name: shown?.name ?? "" })}
      description={t("deleteBody")}
      confirmLabel={t("delete")}
      cancelLabel={r("cancel")}
      loadingLabel={r("working")}
      isLoading={remove.isPending}
      onConfirm={() => segment && remove.mutate(segment.id)}
    />
  );
}
