import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Shield, ShieldAlert, ShieldCheck, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { getServerFnError } from "@/lib/api-helpers";
import {
  fraudCheckerLookup,
  type FraudLookupData,
  type RiskLevel,
} from "@/lib/api-functions/fraud-checker";

interface FraudCheckIndicatorProps {
  phone: string;
  orderId: string;
  initialOpen?: boolean;
}

export function FraudCheckIndicator({
  phone,
  initialOpen = false,
}: FraudCheckIndicatorProps) {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const [isLoading, setIsLoading] = useState(false);
  const [fraudData, setFraudData] = useState<FraudLookupData | null>(null);
  const [hasRequestedFraudData, setHasRequestedFraudData] = useState(false);

  const handleCheck = useCallback(async () => {
    setHasRequestedFraudData(true);
    setIsLoading(true);
    try {
      const result = await fraudCheckerLookup({ data: { phone } });
      setFraudData(result);
    } catch (error) {
      toast.error("Check Failed", { description: getServerFnError(error, "Failed to check fraud data") });
    } finally {
      setIsLoading(false);
    }
  }, [phone]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
  };

  useEffect(() => {
    if (isOpen && !hasRequestedFraudData && !isLoading) {
      void handleCheck();
    }
  }, [handleCheck, hasRequestedFraudData, isLoading, isOpen]);

  const getDeliveryRate = () => {
    if (!fraudData?.total_parcels) return 0;
    return ((fraudData.total_delivered ?? 0) / fraudData.total_parcels) * 100;
  };

  const getRiskLevel = (): RiskLevel => {
    if (!fraudData) return "unknown";
    if (fraudData.riskLevel) return fraudData.riskLevel;
    const deliveryRate =
      (fraudData.total_parcels ?? 0) > 0 ? getDeliveryRate() : 0;

    if ((fraudData.total_parcels ?? 0) === 0) return "unknown";
    if (deliveryRate >= 80) return "low";
    if (deliveryRate >= 50) return "medium";
    return "high";
  };

  const getStatusIcon = () => {
    if (!fraudData) return <Shield className="h-4 w-4" />;

    const riskLevel = getRiskLevel();
    if (riskLevel === "low") {
      return <ShieldCheck className="h-4 w-4 text-green-600" />;
    } else if (riskLevel === "medium") {
      return <Shield className="h-4 w-4 text-yellow-600" />;
    } else if (riskLevel === "high") {
      return <ShieldAlert className="h-4 w-4 text-red-600" />;
    }

    return <Shield className="h-4 w-4 text-gray-600" />;
  };

  const getStatusColor = () => {
    if (!fraudData) return "text-gray-600";
    const riskLevel = getRiskLevel();

    if (riskLevel === "low") return "text-green-600";
    if (riskLevel === "medium") return "text-yellow-600";
    if (riskLevel === "high") return "text-red-600";
    return "text-gray-600";
  };

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          title="Check fraud data"
        >
          {getStatusIcon()}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 z-50 bg-[var(--popover)] text-[var(--popover-foreground)]" align="start">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-sm">Fraud Check Results</h4>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCheck}
              disabled={isLoading}
              className="h-6 px-2 text-xs"
            >
              {isLoading ? (
                <LoaderCircle className="h-3 w-3 animate-spin" />
              ) : (
                "Refresh"
              )}
            </Button>
          </div>

          {isLoading && !fraudData ? (
            <div className="flex items-center justify-center py-8">
              <LoaderCircle className="animate-spin h-6 w-6 text-[var(--muted-foreground)]" />
            </div>
          ) : fraudData ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded bg-[var(--muted)] p-2">
                  <p className="text-xs text-[var(--muted-foreground)]">Total</p>
                  <p className="text-lg font-semibold">{fraudData.total_parcels ?? 0}</p>
                </div>
                <div className="rounded bg-green-50 dark:bg-green-900/20 p-2">
                  <p className="text-xs text-green-600 dark:text-green-400">Delivered</p>
                  <p className="text-lg font-semibold text-green-700 dark:text-green-300">
                    {fraudData.total_delivered ?? 0}
                  </p>
                </div>
                <div className="rounded bg-red-50 dark:bg-red-900/20 p-2">
                  <p className="text-xs text-red-600 dark:text-red-400">Cancelled</p>
                  <p className="text-lg font-semibold text-red-700 dark:text-red-300">
                    {fraudData.total_cancel ?? 0}
                  </p>
                </div>
              </div>

              <div className="rounded bg-[var(--muted)] p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--muted-foreground)]">Risk</span>
                  <span className={`text-sm font-semibold capitalize ${getStatusColor()}`}>
                    {getRiskLevel()}
                  </span>
                </div>
                {(fraudData.provider_status || fraudData.customer_tag || fraudData.message) && (
                  <div className="mt-2 space-y-1 text-xs text-[var(--muted-foreground)]">
                    {(fraudData.provider_status || fraudData.customer_tag) && (
                      <p>Status: {fraudData.provider_status || fraudData.customer_tag}</p>
                    )}
                    {fraudData.message && <p>{fraudData.message}</p>}
                  </div>
                )}
              </div>

              {(fraudData.total_parcels ?? 0) > 0 && (
                <div className="rounded bg-[var(--muted)] p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-[var(--muted-foreground)]">
                      Delivery Rate
                    </span>
                    <span className={`text-sm font-semibold ${getStatusColor()}`}>
                      {getDeliveryRate().toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${getDeliveryRate() >= 80
                          ? "bg-green-500"
                          : getDeliveryRate() >= 50
                            ? "bg-yellow-500"
                            : "bg-red-500"
                        }`}
                      style={{
                        width: `${getDeliveryRate()}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {fraudData.apis && Object.keys(fraudData.apis).length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-[var(--muted-foreground)]">
                    Courier Breakdown
                  </p>
                  {Object.entries(fraudData.apis).map(([courier, data]) => (
                    <div key={courier} className="rounded border border-[var(--border)] p-2">
                      <p className="text-xs font-medium mb-1">{courier}</p>
                      <div className="grid grid-cols-3 gap-1 text-xs">
                        <div>
                          <span className="text-[var(--muted-foreground)]">Total: </span>
                          <span className="font-medium">{data.total_parcels}</span>
                        </div>
                        <div>
                          <span className="text-green-600">Delivered: </span>
                          <span className="font-medium">{data.total_delivered_parcels}</span>
                        </div>
                        <div>
                          <span className="text-red-600">Cancelled: </span>
                          <span className="font-medium">{data.total_cancelled_parcels}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-xs text-[var(--muted-foreground)] text-center">
                Data for: {fraudData.mobile_number}
              </p>
            </div>
          ) : (
            <p className="text-sm text-[var(--muted-foreground)] text-center py-4">
              Click to check fraud data
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
