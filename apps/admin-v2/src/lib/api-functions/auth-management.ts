import { createServerFn } from "@tanstack/react-start";
import { apiBaseGet, apiBasePost, apiDelete, apiGet, apiPost } from "../api.server";

export type TwoFactorMethod = "totp" | "email";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  mustEnrollTwoFactor: boolean;
  suspended: boolean;
  isSuperAdmin: boolean;
  createdAt: string | number;
  roles: { id: string; name: string; displayName: string }[];
  overrides: { grants: string[]; denials: string[] };
}

export interface AdminUsersResponse {
  users: AdminUser[];
}

export interface CreateAdminUserInput {
  name: string;
  email: string;
  roleId?: string;
}

export interface CreateAdminUserResponse {
  message: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
  emailFailed?: boolean;
  onboardingRequired?: boolean;
}

export interface DeleteAdminUserInput {
  userId: string;
}

export interface ResendAdminSetupInput {
  userId: string;
}

export interface SetAdminSuspensionInput {
  userId: string;
  suspended: boolean;
}

export interface SetAdminSuspensionResponse extends MessageResponse {
  suspended: boolean;
}

export interface MessageResponse {
  message: string;
}

export interface UpdateProfileInput {
  name?: string;
  image?: string | null;
}

export interface UpdateProfileResponse {
  user?: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  } | null;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface AccountSecurityResponse {
  twoFactorMethod: string | null;
  isSuperAdmin: boolean;
}

export interface AccountSession {
  commandId: string;
  current: boolean;
  deviceLabel: string;
  deviceType: "desktop" | "mobile" | "tablet" | "unknown";
  networkHint: string | null;
  twoFactorVerified: boolean;
  impersonated: boolean;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
}

export interface AccountSessionsResponse {
  sessions: AccountSession[];
  hasMore: boolean;
}

export interface RevokeAccountSessionInput {
  commandId: string;
}

export interface RevokeOtherAccountSessionsResponse extends MessageResponse {
  revokedCount: number;
}

export type SetTwoFactorMethodInput =
  | { method: "totp"; challengeId: string; code: string; sessionToken?: never }
  | { method: "email"; challengeId: string; sessionToken: string; code?: never }
  | { method: TwoFactorMethod; code: string; sessionToken?: never }
  | { method: TwoFactorMethod; sessionToken: string; code?: never };

export interface SetTwoFactorMethodResponse {
  backupCodes?: string[];
}

export interface StartTwoFactorMethodChallengeInput {
  method: TwoFactorMethod;
  password: string;
}

export interface StartTwoFactorMethodChallengeResponse {
  challengeId: string;
  totpUri: string | null;
  expiresAt: string;
}

export interface VerifyTwoFactorInput {
  code: string;
  trustDevice?: false;
  type?: TwoFactorMethod | "backup";
}

export interface CompleteTwoFactorVerificationInput {
  sessionToken: string;
}

export interface TwoFactorInfoResponse {
  method: string;
  twoFactorEnabled: boolean;
  email: string;
}

export interface SetupStatusResponse {
  adminExists: boolean;
}

export interface RunSetupInput {
  name: string;
  email: string;
  password: string;
}

export interface RunSetupResponse {
  message: string;
  userId: string;
}

export const getAdminUsers = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<AdminUsersResponse>("/auth/users");
  },
);

export const createAdminUser = createServerFn({ method: "POST" })
  .validator((data: CreateAdminUserInput) => data)
  .handler(async ({ data }) => {
    return apiPost<CreateAdminUserResponse>("/auth/users", data);
  });

export const deleteAdminUser = createServerFn({ method: "POST" })
  .validator((data: DeleteAdminUserInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<MessageResponse>(`/auth/users/${data.userId}`);
  });

export const resendAdminSetup = createServerFn({ method: "POST" })
  .validator((data: ResendAdminSetupInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessageResponse>(
      `/auth/users/${encodeURIComponent(data.userId)}/resend-setup`,
      {},
    );
  });

export const setAdminSuspension = createServerFn({ method: "POST" })
  .validator((data: SetAdminSuspensionInput) => data)
  .handler(async ({ data }) => {
    return apiPost<SetAdminSuspensionResponse>(
      `/auth/users/${encodeURIComponent(data.userId)}/suspension`,
      { suspended: data.suspended },
    );
  });

export const updateProfile = createServerFn({ method: "POST" })
  .validator((data: UpdateProfileInput) => data)
  .handler(async ({ data }) => {
    return apiPost<UpdateProfileResponse>("/auth/update-profile", data);
  });

export const changePassword = createServerFn({ method: "POST" })
  .validator((data: ChangePasswordInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessageResponse>("/auth/change-password", data);
  });

export const getAccountSecurity = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<AccountSecurityResponse>("/auth/account-security");
  },
);

export const getAccountSessions = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<AccountSessionsResponse>("/auth/sessions");
  },
);

export const revokeAccountSession = createServerFn({ method: "POST" })
  .validator((data: RevokeAccountSessionInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<MessageResponse>(
      `/auth/sessions/${encodeURIComponent(data.commandId)}`,
    );
  });

export const revokeOtherAccountSessions = createServerFn({ method: "POST" }).handler(
  async () => {
    return apiDelete<RevokeOtherAccountSessionsResponse>("/auth/sessions");
  },
);

export const set2faMethod = createServerFn({ method: "POST" })
  .validator((data: SetTwoFactorMethodInput) => data)
  .handler(async ({ data }) => {
    return apiPost<SetTwoFactorMethodResponse>("/auth/2fa/method", data);
  });

export const startTwoFactorMethodChallenge = createServerFn({ method: "POST" })
  .validator((data: StartTwoFactorMethodChallengeInput) => data)
  .handler(async ({ data }) => {
    return apiPost<StartTwoFactorMethodChallengeResponse>(
      "/auth/2fa/method-challenge",
      data,
    );
  });

export const verify2fa = createServerFn({ method: "POST" })
  .validator((data: VerifyTwoFactorInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessageResponse>("/auth/2fa/verify", data);
  });

export const complete2faVerification = createServerFn({ method: "POST" })
  .validator((data: CompleteTwoFactorVerificationInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessageResponse>("/auth/2fa/complete-verification", data);
  });

export const get2faInfo = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<TwoFactorInfoResponse>("/auth/2fa/info");
  },
);

export const getSetupStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiBaseGet<SetupStatusResponse>("/setup");
  },
);

export const runSetup = createServerFn({ method: "POST" })
  .validator((data: RunSetupInput) => data)
  .handler(async ({ data }) => {
    return apiBasePost<RunSetupResponse>("/setup", data);
  });
