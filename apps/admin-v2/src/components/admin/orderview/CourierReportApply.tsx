import { lazy, Suspense, useState } from "react";
import { Button } from "~/components/ui/button";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { useMessages } from "~/i18n";
import { orderDetailLabel, orderDetailMessages } from "~/i18n/order-detail";

const ConfirmDialog = lazy(() => import("~/components/admin/shared/ConfirmDialog").then((module) => ({ default: module.ConfirmDialog })));

/**
 * Applying a courier's report over a settled parcel, behind the one
 * confirmation that names what it does to the order and its stock: the held
 * shipment's decision and a set-aside report's "apply after all" both use it.
 */
export function CourierReportApply({ reportedStatus, label, pending, apply }: {
  reportedStatus: string;
  /** The button's words; the confirmation's own button always names the report. */
  label?: string;
  pending: boolean;
  apply: () => void;
}) {
  const t = useMessages(orderDetailMessages);
  const [confirming, setConfirming] = useState(false);
  const opened = useOpenedOnce(confirming);
  const reported = orderDetailLabel(t, "courierReport.state.", reportedStatus);
  return (
    <>
      <Button type="button" size="sm" variant="outline" loading={pending} onClick={() => setConfirming(true)}>
        {label ?? t("courierReport.apply", { reported })}
      </Button>
      {opened ? (
        <Suspense fallback={null}>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t("courierReport.confirmTitle", { reported })}
            description={orderDetailLabel(t, "courierReport.effect.", reportedStatus)}
            confirmLabel={t("courierReport.apply", { reported })}
            isLoading={pending}
            onConfirm={() => { apply(); setConfirming(false); }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
