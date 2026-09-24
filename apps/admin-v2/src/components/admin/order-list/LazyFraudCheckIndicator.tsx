import { lazy, Suspense, useState } from "react";
import { LoaderCircle, Shield } from "lucide-react";
import { Button } from "../../ui/button";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";

const FraudCheckIndicator = lazy(() =>
  import("./FraudCheckIndicator").then((module) => ({
    default: module.FraudCheckIndicator,
  })),
);

function HistoryTrigger({
  customerName,
  isLoading = false,
  onActivate,
}: {
  customerName: string;
  isLoading?: boolean;
  onActivate?: () => void;
}) {
  const t = useMessages(orderListMessages);
  const label = t("checkHistoryFor", { name: customerName });
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      aria-busy={isLoading || undefined}
      disabled={isLoading}
      onClick={onActivate}
    >
      {isLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
    </Button>
  );
}

/** Shield button that loads the customer's courier delivery history on first click; hidden without access. */
export function LazyFraudCheckIndicator({ phone, customerName }: { phone: string; customerName: string }) {
  const { canViewFraudCheck } = useOrderActionPermissions();
  const [shouldLoad, setShouldLoad] = useState(false);
  if (!canViewFraudCheck) return null;
  if (!shouldLoad) return <HistoryTrigger customerName={customerName} onActivate={() => setShouldLoad(true)} />;
  return (
    <Suspense fallback={<HistoryTrigger customerName={customerName} isLoading />}>
      <FraudCheckIndicator phone={phone} trigger={<HistoryTrigger customerName={customerName} />} />
    </Suspense>
  );
}
