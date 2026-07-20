export interface AdminUserStatusInput {
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  mustEnrollTwoFactor: boolean;
  suspended: boolean;
  invitation?: {
    status: "pending" | "expired" | "delivery_failed";
  } | null;
}

export type AdminUserStatus =
  | "ready"
  | "suspended"
  | "invite_pending"
  | "invite_expired"
  | "invite_delivery_failed"
  | "password_setup"
  | "two_factor_setup";

export function getAdminUserStatus(
  user: AdminUserStatusInput,
): AdminUserStatus {
  if (user.suspended) return "suspended";
  if (user.invitation?.status === "delivery_failed") {
    return "invite_delivery_failed";
  }
  if (user.invitation?.status === "expired") return "invite_expired";
  if (user.invitation?.status === "pending") return "invite_pending";
  if (user.mustChangePassword) return "password_setup";
  if (user.mustEnrollTwoFactor || !user.twoFactorEnabled) {
    return "two_factor_setup";
  }
  return "ready";
}

export const ADMIN_USER_STATUS_COPY: Record<
  AdminUserStatus,
  { label: string; description: string }
> = {
  ready: {
    label: "Ready",
    description: "Password and two-factor authentication are configured.",
  },
  suspended: {
    label: "Suspended",
    description: "This administrator cannot sign in until access is restored.",
  },
  invite_pending: {
    label: "Invite pending",
    description: "The setup link was sent and has not been completed.",
  },
  invite_expired: {
    label: "Invite expired",
    description: "The last setup link expired. Send a new one to continue.",
  },
  invite_delivery_failed: {
    label: "Delivery failed",
    description: "The setup email was not delivered. Check email settings and retry.",
  },
  password_setup: {
    label: "Password setup",
    description: "This administrator must finish the secure setup link.",
  },
  two_factor_setup: {
    label: "2FA setup",
    description: "This administrator must enable two-factor authentication.",
  },
};

export function isAdminUserAuthorityReady({
  isLoading,
  error,
}: {
  isLoading: boolean;
  error: string | null;
}): boolean {
  return !isLoading && error === null;
}
