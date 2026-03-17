import { apiGet } from "@/lib/api-fetch";
import { layoutCache, CACHE_KEYS } from "@scalius/shared/layout-cache";

export interface FirebaseConfig {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
  vapidKey?: string;
}

export async function getSetupAdminExists(): Promise<boolean> {
  try {
    // Setup endpoint is at /api/v1/setup (not under /admin), so call directly
    const response = await fetch("/api/v1/setup");
    if (!response.ok) return false;
    const body = await response.json() as any;
    // API returns { success: true, data: { adminExists: boolean } }
    // Since this is NOT going through the admin proxy, we read data directly
    return body?.data?.adminExists ?? false;
  } catch {
    return false;
  }
}

export async function getSidebarStorefrontUrl(): Promise<string> {
  const cached = layoutCache.get<string>(CACHE_KEYS.STOREFRONT_URL) ?? null;
  if (cached !== null) return cached;

  try {
    const result = await apiGet<{ storefrontUrl: string }>("/settings/storefront-url");
    const storefrontUrl = result.storefrontUrl || "/";
    layoutCache.set(CACHE_KEYS.STOREFRONT_URL, storefrontUrl);
    return storefrontUrl;
  } catch (error) {
    console.warn("Could not fetch storefront URL, using default:", error);
    return "/";
  }
}

export async function getAdminLayoutFirebaseConfig(
  defaultConfig: FirebaseConfig,
): Promise<FirebaseConfig> {
  const cached = layoutCache.get<FirebaseConfig>(CACHE_KEYS.FIREBASE_CONFIG);
  if (cached) return cached;

  let firebaseConfig: FirebaseConfig = { ...defaultConfig };
  try {
    // Firebase config is at /api/v1/auth/firebase-config (public, not under /admin)
    const response = await fetch("/api/v1/auth/firebase-config");
    if (response.ok) {
      const body = await response.json() as any;
      // API returns { success: true, data: { ...config } }
      const dbConfig = body?.data || {};
      firebaseConfig = { ...firebaseConfig, ...dbConfig };
      if (dbConfig.vapidKey) firebaseConfig.vapidKey = dbConfig.vapidKey;
    }
    layoutCache.set(CACHE_KEYS.FIREBASE_CONFIG, firebaseConfig);
  } catch (error) {
    console.error("Error loading Firebase settings in layout:", error);
  }

  return firebaseConfig;
}

export async function getAccountSecurityData(_userId: string): Promise<{
  twoFactorMethod: string | null;
  isSuperAdmin: boolean;
}> {
  try {
    const result = await apiGet<{
      twoFactorMethod: string | null;
      isSuperAdmin: boolean;
    }>("/auth/account-security");
    return {
      twoFactorMethod: result.twoFactorMethod || null,
      isSuperAdmin: result.isSuperAdmin ?? false,
    };
  } catch {
    return {
      twoFactorMethod: null,
      isSuperAdmin: false,
    };
  }
}
