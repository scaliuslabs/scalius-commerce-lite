import { Truck, Package } from "lucide-react";

/** Visual config for each provider type: icon, color scheme, description */
export const PROVIDER_VISUAL: Record<
  string,
  {
    icon: typeof Truck;
    bgClass: string;
    iconClass: string;
    badgeClass: string;
    description: string;
  }
> = {
  pathao: {
    icon: Truck,
    bgClass: "bg-orange-100 dark:bg-orange-950/40",
    iconClass: "text-orange-600 dark:text-orange-400",
    badgeClass: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400 border-orange-200 dark:border-orange-900",
    description: "Ride-sharing & delivery platform",
  },
  steadfast: {
    icon: Package,
    bgClass: "bg-blue-100 dark:bg-blue-950/40",
    iconClass: "text-blue-600 dark:text-blue-400",
    badgeClass: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400 border-blue-200 dark:border-blue-900",
    description: "Courier & logistics service",
  },
};

/** Provider type options */
export type DeliveryProviderType = "pathao" | "steadfast";

export const PROVIDER_TYPES: { value: DeliveryProviderType; label: string }[] = [
  { value: "pathao", label: "Pathao" },
  { value: "steadfast", label: "Steadfast" },
];

/** Represents a delivery provider record from the database */
export interface DeliveryProviderRecord {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  credentials: string;
  config: string;
  createdAt?: Date | string | number;
  updatedAt?: Date | string | number;
}

export function ProviderIcon({
  type,
  size = "md",
}: {
  type: string;
  size?: "sm" | "md" | "lg";
}) {
  const visual = PROVIDER_VISUAL[type] || PROVIDER_VISUAL.pathao;
  const Icon = visual.icon;
  const sizeClasses = {
    sm: "p-1.5 rounded-md",
    md: "p-2 rounded-lg",
    lg: "p-3 rounded-xl",
  };
  const iconSizes = {
    sm: "h-3.5 w-3.5",
    md: "h-5 w-5",
    lg: "h-7 w-7",
  };
  return (
    <div className={`flex-shrink-0 ${visual.bgClass} ${sizeClasses[size]}`}>
      <Icon className={`${iconSizes[size]} ${visual.iconClass}`} />
    </div>
  );
}
