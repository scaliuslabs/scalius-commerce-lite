import { Package } from "lucide-react";
import {
  OfficialProviderMark,
  type ProviderMarkId,
} from "~/components/admin/settings/provider-marks";

// The readiness rules live in provider-readiness.ts (no logos there).
export * from "./provider-readiness";

/** Provider type options */
export type DeliveryProviderType = "pathao" | "steadfast";

const DELIVERY_PROVIDER_MARKS: Record<DeliveryProviderType, ProviderMarkId> = {
  pathao: "pathao",
  steadfast: "steadfast",
};

function getDeliveryProviderMarkId(type: string): ProviderMarkId | null {
  return type in DELIVERY_PROVIDER_MARKS
    ? DELIVERY_PROVIDER_MARKS[type as DeliveryProviderType]
    : null;
}

export function ProviderIcon({
  type,
  size = "md",
}: {
  type: string;
  size?: "sm" | "md" | "lg";
}) {
  const provider = getDeliveryProviderMarkId(type);
  if (provider) {
    return (
      <OfficialProviderMark
        provider={provider}
        size={size === "sm" ? "sm" : "md"}
      />
    );
  }

  const sizeClasses = {
    sm: "h-6 w-6 rounded-md",
    md: "h-8 w-8 rounded-lg",
    lg: "h-10 w-10 rounded-xl",
  };
  const iconSizes = {
    sm: "h-3.5 w-3.5",
    md: "h-5 w-5",
    lg: "h-7 w-7",
  };
  return (
    <div
      className={`flex shrink-0 items-center justify-center bg-muted text-muted-foreground ${sizeClasses[size]}`}
      aria-hidden="true"
    >
      <Package className={iconSizes[size]} />
    </div>
  );
}
