import { lazy, Suspense, useState } from "react";
import { LoaderCircle, Shield } from "lucide-react";
import { Button } from "../../ui/button";
import { useMessages } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";

const FraudCheckIndicator = lazy(() =>
  import("./FraudCheckIndicator").then((module) => ({
    default: module.FraudCheckIndicator,
  })),
);

function HistoryTrigger({ isLoading = false, onActivate }: { isLoading?: boolean; onActivate?: () => void }) {
  const t = useMessages(orderListMessages);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={t("checkHistory")}
      aria-label={t("checkHistory")}
      aria-busy={isLoading || undefined}
      disabled={isLoading}
      onClick={onActivate}
    >
      {isLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
    </Button>
  );
}

/** Shield button that loads the customer's courier delivery history on first click. */
export function LazyFraudCheckIndicator({ phone }: { phone: string }) {
  const [shouldLoad, setShouldLoad] = useState(false);
  if (!shouldLoad) return <HistoryTrigger onActivate={() => setShouldLoad(true)} />;
  return (
    <Suspense fallback={<HistoryTrigger isLoading />}>
      <FraudCheckIndicator phone={phone} trigger={<HistoryTrigger />} />
    </Suspense>
  );
}
