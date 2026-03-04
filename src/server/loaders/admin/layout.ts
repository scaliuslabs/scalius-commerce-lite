import { db } from "@/db";
import { settings, siteSettings, user as userTable } from "@/db/schema";
import { and, count, eq } from "drizzle-orm";
import { layoutCache, CACHE_KEYS } from "@/shared/layout-cache";

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
  const adminResult = await db
    .select({ count: count() })
    .from(userTable)
    .where(eq(userTable.role, "admin"));
  return (adminResult[0]?.count ?? 0) > 0;
}

export async function getSidebarStorefrontUrl(): Promise<string> {
  let storefrontUrl = layoutCache.get<string>(CACHE_KEYS.STOREFRONT_URL) ?? null;
  if (storefrontUrl !== null) return storefrontUrl;

  try {
    const [storefrontSettings] = await db
      .select({ storefrontUrl: siteSettings.storefrontUrl })
      .from(siteSettings)
      .limit(1);
    storefrontUrl = storefrontSettings?.storefrontUrl || "/";
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
    const result = await db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(eq(settings.key, "public_config"), eq(settings.category, "firebase")),
      )
      .get();

    if (result?.value) {
      const dbConfig = JSON.parse(result.value);
      firebaseConfig = { ...firebaseConfig, ...dbConfig };
      if (dbConfig.vapidKey) firebaseConfig.vapidKey = dbConfig.vapidKey;
    }
    layoutCache.set(CACHE_KEYS.FIREBASE_CONFIG, firebaseConfig);
  } catch (error) {
    console.error("Error loading Firebase settings in layout:", error);
  }

  return firebaseConfig;
}

export async function getAccountSecurityData(userId: string): Promise<{
  twoFactorMethod: string | null;
  isSuperAdmin: boolean;
}> {
  const dbUser = await db
    .select({
      twoFactorMethod: userTable.twoFactorMethod,
      isSuperAdmin: userTable.isSuperAdmin,
    })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .get();

  return {
    twoFactorMethod: dbUser?.twoFactorMethod || null,
    isSuperAdmin: dbUser?.isSuperAdmin ?? false,
  };
}
