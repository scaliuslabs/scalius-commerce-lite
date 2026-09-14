import type { ReadinessStatus } from "@scalius/shared/readiness";
import { Truck, Package } from "lucide-react";
import {
  OfficialProviderMark,
  type ProviderMarkId,
} from "~/components/admin/settings/provider-marks";

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

const DELIVERY_PROVIDER_MARKS: Record<DeliveryProviderType, ProviderMarkId> = {
  pathao: "pathao",
  steadfast: "steadfast",
};

export function getDeliveryProviderMarkId(type: string): ProviderMarkId | null {
  return type in DELIVERY_PROVIDER_MARKS
    ? DELIVERY_PROVIDER_MARKS[type as DeliveryProviderType]
    : null;
}

export const PROVIDER_TYPES: { value: DeliveryProviderType; label: string }[] = [
  { value: "pathao", label: "Pathao" },
  { value: "steadfast", label: "Steadfast" },
];

/** Setup lifecycle position. The readiness verdict is the shared `status`. */
export type DeliveryProviderLifecycle =
  | "draft"
  | "configured"
  | "tested"
  | "active"
  | "blocked";

/** The shared readiness verdict itself; never a lifecycle position. */
export type DeliveryProviderReadinessStatus = ReadinessStatus;

/** Mirrors `ReadinessIssue` in packages/shared/src/readiness.ts. */
export interface DeliveryProviderReadinessIssue {
  code: "inactive" | "unconfigured" | "untested" | "test_failed" | "unreadable" | string;
  message: string;
  fix?: string;
}

export interface DeliveryProviderReadiness {
  status: DeliveryProviderReadinessStatus;
  lifecycle: DeliveryProviderLifecycle;
  configured?: boolean;
  tested?: boolean;
  active?: boolean;
  canCreateShipment: boolean;
  issues: DeliveryProviderReadinessIssue[];
  activationBlockers?: Array<{
    source: "credentials" | "config" | string;
    key: string;
    label: string;
    message: string;
  }>;
  lastTestAttemptAt?: string | number | null;
  lastTestSuccessAt?: string | number | null;
  lastTestFailureAt?: string | number | null;
}

/** Represents a delivery provider record from the database */
export interface DeliveryProviderRecord {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  credentials: string;
  config: string;
  readiness?: DeliveryProviderReadiness | null;
  createdAt?: Date | string | number;
  updatedAt?: Date | string | number;
}

const LIFECYCLE_LABELS: Record<DeliveryProviderLifecycle, string> = {
  draft: "Draft",
  configured: "Configured",
  tested: "Tested",
  active: "Active",
  blocked: "Blocked",
};

const FALLBACK_INACTIVE_ISSUE: DeliveryProviderReadinessIssue = {
  code: "inactive",
  message: "Turn on this provider after setup and testing.",
};

export function resolveProviderReadiness(
  provider: Pick<DeliveryProviderRecord, "isActive" | "readiness">,
): DeliveryProviderReadiness {
  if (provider.readiness) {
    const canCreateShipment =
      provider.readiness.canCreateShipment ?? provider.readiness.active ?? false;
    return {
      status: provider.readiness.status,
      lifecycle: provider.readiness.lifecycle,
      configured: provider.readiness.configured,
      tested: provider.readiness.tested,
      active: provider.readiness.active,
      canCreateShipment,
      issues: Array.isArray(provider.readiness.issues)
        ? provider.readiness.issues
        : [],
      activationBlockers: provider.readiness.activationBlockers,
      lastTestAttemptAt: provider.readiness.lastTestAttemptAt ?? null,
      lastTestSuccessAt: provider.readiness.lastTestSuccessAt ?? null,
      lastTestFailureAt: provider.readiness.lastTestFailureAt ?? null,
    };
  }

  // No readiness on the record: trust only the saved active flag.
  return {
    status: provider.isActive ? "ready" : "incomplete",
    lifecycle: provider.isActive ? "active" : "draft",
    canCreateShipment: provider.isActive,
    issues: provider.isActive ? [] : [FALLBACK_INACTIVE_ISSUE],
    activationBlockers: [],
    lastTestAttemptAt: null,
    lastTestSuccessAt: null,
    lastTestFailureAt: null,
  };
}

export function getProviderReadinessLabel(
  readiness: Pick<DeliveryProviderReadiness, "lifecycle">,
) {
  return LIFECYCLE_LABELS[readiness.lifecycle] ?? "Draft";
}

export function getProviderReadinessBadgeClass(
  readiness: Pick<DeliveryProviderReadiness, "lifecycle" | "canCreateShipment">,
) {
  if (!readiness.canCreateShipment || readiness.lifecycle === "blocked") {
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  }
  if (readiness.lifecycle === "active") {
    return "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300";
  }
  if (readiness.lifecycle === "tested") {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  if (readiness.lifecycle === "configured") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "text-muted-foreground";
}

export function getProviderReadinessMessage(
  readiness: Pick<DeliveryProviderReadiness, "canCreateShipment" | "issues">,
) {
  if (readiness.canCreateShipment) {
    return "Ready to create shipments.";
  }
  const issue = readiness.issues[0];
  if (issue?.message) return issue.message;
  return "Complete provider setup before creating shipments.";
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
