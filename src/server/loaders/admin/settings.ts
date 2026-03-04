import { db } from "@/db";
import { metaConversionsSettings, deliveryProviders, siteSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

const MASKED_VALUE = "••••••••••••";

function safeParseJSON(jsonString: string | null | undefined) {
  if (!jsonString) return null;
  try {
    return JSON.parse(jsonString);
  } catch {
    return null;
  }
}

function maskCredentials(credentialsJson: string): string {
  try {
    const credentials = JSON.parse(credentialsJson);
    const masked = { ...credentials };

    if (masked.clientSecret) masked.clientSecret = MASKED_VALUE;
    if (masked.password) masked.password = MASKED_VALUE;
    if (masked.apiKey) masked.apiKey = MASKED_VALUE;
    if (masked.secretKey) masked.secretKey = MASKED_VALUE;

    return JSON.stringify(masked);
  } catch {
    return credentialsJson;
  }
}

export async function getGeneralSettingsData(): Promise<{
  headerConfig: any;
  footerConfig: any;
}> {
  const [settings] = await db.select().from(siteSettings).limit(1);
  return {
    headerConfig: safeParseJSON(settings?.headerConfig) || {},
    footerConfig: safeParseJSON(settings?.footerConfig) || {},
  };
}

export async function getMetaConversionSettingsData() {
  const dbSettings = await db
    .select()
    .from(metaConversionsSettings)
    .where(eq(metaConversionsSettings.id, "singleton"))
    .get();

  if (!dbSettings) return undefined;
  return {
    ...dbSettings,
    accessToken: dbSettings.accessToken ? MASKED_VALUE : null,
  };
}

export async function getDeliveryProvidersData() {
  const dbProviders = await db.select().from(deliveryProviders);
  return dbProviders.map((provider) => ({
    ...provider,
    credentials: maskCredentials(provider.credentials),
  }));
}
