import {
  type Readiness,
  type ReadinessIssue,
  type ReadinessStatus,
} from "@scalius/shared/readiness";

export type DeliveryProviderActivationRequirement = {
  source: "credentials" | "config";
  key: string;
  label: string;
};

export type DeliveryProviderActivationBlocker = DeliveryProviderActivationRequirement & {
  message: string;
};

/**
 * Where a provider sits on the setup path. This is a lifecycle position, not a
 * readiness verdict -- the verdict is the shared `status` on the summary below.
 */
export type DeliveryProviderLifecycle = "draft" | "configured" | "tested" | "active" | "blocked";

export type DeliveryProviderReadinessBlocker = ReadinessIssue & {
  code: "inactive" | "unconfigured" | "unreadable";
};

/**
 * The shared readiness vocabulary (`status` + `issues`) plus the typed extras
 * the delivery settings screen renders.
 */
export type DeliveryProviderReadinessSummary = Readiness & {
  issues: DeliveryProviderReadinessBlocker[];
  lifecycle: DeliveryProviderLifecycle;
  configured: boolean;
  tested: boolean;
  active: boolean;
  activationBlockers: DeliveryProviderActivationBlocker[];
  lastTestAttemptAt?: Date | number | string | null;
  lastTestSuccessAt?: Date | number | string | null;
  lastTestFailureAt?: Date | number | string | null;
};

type DeliveryProviderSummaryInput = {
  type: string;
  credentialsReadable?: boolean;
  /**
   * What keeps the setup from shipping, from the courier that reads it (an
   * app courier's setup lives in the app's settings). Absent: the row names
   * no courier this request can use.
   */
  activationBlockers?: DeliveryProviderActivationBlocker[];
  isActive?: boolean | null;
  lastTestAttemptAt?: Date | number | string | null;
  lastTestSuccessAt?: Date | number | string | null;
  lastTestFailureAt?: Date | number | string | null;
};

export function getDeliveryProviderReadinessSummary(
  input: DeliveryProviderSummaryInput,
): DeliveryProviderReadinessSummary {
  const credentialsUnreadable = input.credentialsReadable === false;
  const activationBlockers = credentialsUnreadable
    ? [{
        source: "credentials" as const,
        key: "credentials",
        label: "Credentials",
        message: "Stored credentials cannot be decrypted with the configured credential key.",
      }]
    : input.activationBlockers ?? [{
      source: "config" as const,
      key: "type",
      label: "Provider type",
      message: `Unsupported delivery provider type: ${input.type}`,
    }];
  const configured = activationBlockers.length === 0;
  // A courier's setup is tested through its app (the app's own connection test): no proof on the row.
  const tested = configured;
  const active = Boolean(input.isActive) && tested;

  const blockers: DeliveryProviderReadinessBlocker[] = [];
  if (!input.isActive) {
    blockers.push({
      code: "inactive",
      message: "Delivery provider is inactive.",
    });
  }
  if (!configured) {
    blockers.push({
      code: credentialsUnreadable
        || activationBlockers.some((blocker) => blocker.key === "credentials" || blocker.key === "config")
        ? "unreadable"
        : "unconfigured",
      message: credentialsUnreadable
        ? "Delivery provider credentials cannot be decrypted with the configured credential key. Re-enter and retest the provider credentials."
        // The courier's own reason ("Activate Bangladesh pack in Apps to use it.").
        : activationBlockers[0]?.message ?? "Delivery provider setup is incomplete or unreadable.",
    });
  }

  let lifecycle: DeliveryProviderLifecycle;
  if (active) {
    lifecycle = "active";
  } else if (input.isActive && blockers.length > 0) {
    lifecycle = "blocked";
  } else if (!configured) {
    lifecycle = activationBlockers.length > 0 && activationBlockers.some((blocker) => blocker.key === "type")
      ? "blocked"
      : "draft";
  } else {
    lifecycle = "tested";
  }

  // Unreadable credentials are a platform failure, not merchant setup left undone.
  const status: ReadinessStatus = active
    ? "ready"
    : blockers.some((blocker) => blocker.code === "unreadable")
      ? "error"
      : "incomplete";
  return {
    status,
    issues: blockers,
    lifecycle,
    configured,
    tested,
    active,
    activationBlockers,
    lastTestAttemptAt: input.lastTestAttemptAt,
    lastTestSuccessAt: input.lastTestSuccessAt,
    lastTestFailureAt: input.lastTestFailureAt,
  };
}
