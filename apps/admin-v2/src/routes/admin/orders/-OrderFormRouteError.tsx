import { useRouter } from "@tanstack/react-router";
import { ErrorState } from "~/components/admin/states/ErrorState";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";

/** Create/Edit order load failure: what failed, why, Try again, Back to orders. */
export function OrderFormRouteError({ error, reset }: { error: Error; reset: () => void }) {
  const t = useMessages(orderFormMessages);
  const router = useRouter();
  return (
    <ErrorState
      error={error}
      layout="page"
      title={t("loadFailed")}
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
      backTo={{ to: "/admin/orders", label: t("backToOrders") }}
    />
  );
}
