export type PreferredTwoFactorMethod = "totp" | "email";
export type VerifyTwoFactorMethod = PreferredTwoFactorMethod | "backup";

const PENDING_TWO_FACTOR_METHODS_KEY = "scalius.pendingTwoFactorMethods";

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function normalizePendingTwoFactorMethods(
  methods: readonly unknown[] | undefined,
): PreferredTwoFactorMethod[] {
  if (!Array.isArray(methods)) return [];

  const normalized: PreferredTwoFactorMethod[] = [];
  for (const method of methods) {
    const value = typeof method === "string" ? method.toLowerCase() : "";
    const nextMethod =
      value === "totp"
        ? "totp"
        : value === "otp" || value === "email"
          ? "email"
          : null;
    if (nextMethod && !normalized.includes(nextMethod)) {
      normalized.push(nextMethod);
    }
  }

  return normalized;
}

export function getPreferredMethod(method: string | null | undefined): PreferredTwoFactorMethod {
  return method === "totp" ? "totp" : "email";
}

export function chooseInitialTwoFactorMethod(options: {
  defaultMethod?: PreferredTwoFactorMethod;
  pendingMethods?: readonly PreferredTwoFactorMethod[];
  apiMethod?: string | null;
}): PreferredTwoFactorMethod {
  if (options.defaultMethod) return options.defaultMethod;
  const pendingMethod = options.pendingMethods?.[0];
  if (pendingMethod) return pendingMethod;
  return getPreferredMethod(options.apiMethod);
}

export function storePendingTwoFactorMethods(methods: readonly unknown[] | undefined): void {
  const storage = getSessionStorage();
  if (!storage) return;

  const normalized = normalizePendingTwoFactorMethods(methods);
  if (normalized.length === 0) {
    storage.removeItem(PENDING_TWO_FACTOR_METHODS_KEY);
    return;
  }

  storage.setItem(PENDING_TWO_FACTOR_METHODS_KEY, JSON.stringify(normalized));
}

export function readPendingTwoFactorMethods(): PreferredTwoFactorMethod[] {
  const storage = getSessionStorage();
  if (!storage) return [];

  try {
    const parsed = JSON.parse(storage.getItem(PENDING_TWO_FACTOR_METHODS_KEY) ?? "[]") as unknown;
    return normalizePendingTwoFactorMethods(Array.isArray(parsed) ? parsed : undefined);
  } catch {
    storage.removeItem(PENDING_TWO_FACTOR_METHODS_KEY);
    return [];
  }
}

export function clearPendingTwoFactorMethods(): void {
  getSessionStorage()?.removeItem(PENDING_TWO_FACTOR_METHODS_KEY);
}
