export interface AdminUserStatusInput {
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  mustEnrollTwoFactor: boolean;
  suspended: boolean;
}

export type AdminUserStatus =
  | "ready"
  | "suspended"
  | "password_setup"
  | "two_factor_setup";

export function getAdminUserStatus(
  user: AdminUserStatusInput,
): AdminUserStatus {
  if (user.suspended) return "suspended";
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
