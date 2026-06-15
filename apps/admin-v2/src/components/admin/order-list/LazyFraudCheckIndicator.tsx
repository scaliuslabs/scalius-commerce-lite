import { lazy, Suspense, useState } from "react";
import { LoaderCircle, Shield } from "lucide-react";
import { Button } from "../../ui/button";

const FraudCheckIndicator = lazy(() =>
  import("./FraudCheckIndicator").then((module) => ({
    default: module.FraudCheckIndicator,
  })),
);

interface LazyFraudCheckIndicatorProps {
  phone: string;
  orderId: string;
}

interface FraudTriggerShellProps {
  isLoading?: boolean;
  onActivate?: () => void;
}

function FraudTriggerShell({
  isLoading = false,
  onActivate,
}: FraudTriggerShellProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      className="h-8 w-8 p-0"
      title="Check fraud data"
      aria-label="Check fraud data"
      aria-busy={isLoading || undefined}
      disabled={isLoading}
      onClick={onActivate}
    >
      {isLoading ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : (
        <Shield className="h-4 w-4" />
      )}
    </Button>
  );
}

export function LazyFraudCheckIndicator({
  phone,
  orderId,
}: LazyFraudCheckIndicatorProps) {
  const [shouldLoad, setShouldLoad] = useState(false);

  if (!shouldLoad) {
    return <FraudTriggerShell onActivate={() => setShouldLoad(true)} />;
  }

  return (
    <Suspense fallback={<FraudTriggerShell isLoading />}>
      <FraudCheckIndicator phone={phone} orderId={orderId} initialOpen />
    </Suspense>
  );
}
