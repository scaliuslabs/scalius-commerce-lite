import type { ReadinessStatus } from "@scalius/shared/readiness";
import { Package } from "lucide-react";
import {
  OfficialProviderMark,
  type ProviderMarkId,
} from "~/components/admin/settings/provider-marks";

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
