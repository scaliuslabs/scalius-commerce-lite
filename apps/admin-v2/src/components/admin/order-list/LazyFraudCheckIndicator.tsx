import { lazy, Suspense, useState } from "react";
import { LoaderCircle, Shield } from "lucide-react";
import { Button } from "../../ui/button";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderMessages } from "~/i18n/orders";

const FraudCheckIndicator = lazy(() =>
  import("./FraudCheckIndicator").then((module) => ({
    default: module.FraudCheckIndicator,
  })),
);

function HistoryTrigger({
  customerName,
  isLoading = false,
  compact = false,
  onActivate,
}: {
  customerName: string;
  isLoading?: boolean;
  /** The orders list's size: it fits beside two lines of text without making the row taller. */
  compact?: boolean;
  onActivate?: () => void;
}) {
  const t = useMessages(orderMessages);
  const label = t("checkHistoryFor", { name: customerName });
  return (
    <Button
      type="button"
      variant="ghost"
      size={compact ? "icon-sm" : "icon"}
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
export function LazyFraudCheckIndicator({ phone, customerName, countryCode, compact = false }: {
  phone: string;
  customerName: string;
  /** The order's shipping country: a checker that doesn't know buyers there isn't asked. */
  countryCode?: string | null;
  compact?: boolean;
}) {
  const { canViewFraudCheck } = useOrderActionPermissions();
  const [shouldLoad, setShouldLoad] = useState(false);
  if (!canViewFraudCheck) return null;
  if (!shouldLoad) return <HistoryTrigger customerName={customerName} compact={compact} onActivate={() => setShouldLoad(true)} />;
  return (
    <Suspense fallback={<HistoryTrigger customerName={customerName} compact={compact} isLoading />}>
      <FraudCheckIndicator phone={phone} countryCode={countryCode ?? null} trigger={<HistoryTrigger customerName={customerName} compact={compact} />} />
    </Suspense>
  );
}
