import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { analytics, metaConversionsSettings } from "@scalius/database/schema";

import { readStoredCredentialStrict } from "../../utils/credential-encryption";
import {
  CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC,
  analyticsScriptTypes,
  getActiveAnalyticsConfigError,
  type AnalyticsScriptType,
} from "./analytics.validation";

export const analyticsProviderHealthBrowserStatuses = [
  "ready",
  "draft",
  "blocked",
  "not_configured",
] as const;

export const analyticsProviderHealthServerStatuses = [
  "ready",
  "blocked",
  "not_configured",
  "not_applicable",
] as const;

export type AnalyticsProviderHealthBrowserStatus =
  (typeof analyticsProviderHealthBrowserStatuses)[number];

export type AnalyticsProviderHealthServerStatus =
  (typeof analyticsProviderHealthServerStatuses)[number];

export interface AnalyticsProviderHealthScript {
  type: string | null;
  config: string | null;
  isActive: boolean | null;
}

export interface AnalyticsProviderBrowserReadiness {
  status: AnalyticsProviderHealthBrowserStatus;
  configured: boolean;
  activeScriptCount: number;
  readyScriptCount: number;
  draftScriptCount: number;
  blockedScriptCount: number;
  message: string;
  issues: string[];
}

export interface AnalyticsProviderServerReadiness {
  status: AnalyticsProviderHealthServerStatus;
  configured: boolean;
  label: string;
  message: string;
}

export interface AnalyticsProviderHealthItem {
  provider: AnalyticsScriptType;
  label: string;
  browser: AnalyticsProviderBrowserReadiness;
  serverSide: AnalyticsProviderServerReadiness;
}

export interface AnalyticsProviderHealthSummary {
  totalProviders: number;
  browserReadyProviders: number;
  draftProviders: number;
  blockedProviders: number;
  notConfiguredProviders: number;
  serverReadyProviders: number;
}

export interface AnalyticsProviderHealthResponse {
  summary: AnalyticsProviderHealthSummary;
  providers: AnalyticsProviderHealthItem[];
}

interface ProviderDefinition {
  provider: AnalyticsScriptType;
  label: string;
  defaultServerSide: AnalyticsProviderServerReadiness;
}

interface MetaCapiSettingsForHealth {
  pixelId: string | null;
  accessToken: string | null;
  isEnabled: boolean;
}

interface BuildAnalyticsProviderHealthOptions {
  metaServerSide?: AnalyticsProviderServerReadiness;
}

interface GetAnalyticsProviderHealthOptions {
  credentialEncryptionKey?: string;
}

const CLOUDFLARE_WEB_ANALYTICS_TOKEN_PLACEHOLDER =
  "YOUR_CLOUDFLARE_WEB_ANALYTICS_TOKEN";
const CLOUDFLARE_WEB_ANALYTICS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const META_PIXEL_ID_PATTERN = /^\d{5,30}$/;

const BROWSER_ONLY_GOOGLE_ANALYTICS: AnalyticsProviderServerReadiness = {
  status: "not_configured",
  configured: false,
  label: "Browser only",
  message:
    "GA4 browser events can run through gtag.js; server-side conversion is not configured yet.",
};

const BROWSER_ONLY_GOOGLE_TAG_MANAGER: AnalyticsProviderServerReadiness = {
  status: "not_configured",
  configured: false,
  label: "Browser only",
  message:
    "GTM can load browser tags; server-side conversion is not configured yet.",
};

const BROWSER_ONLY_TIKTOK_PIXEL: AnalyticsProviderServerReadiness = {
  status: "not_configured",
  configured: false,
  label: "Browser only",
  message:
    "TikTok Pixel is browser-only here; TikTok Events API is not configured yet.",
};

const NOT_APPLICABLE_CLOUDFLARE: AnalyticsProviderServerReadiness = {
  status: "not_applicable",
  configured: false,
  label: "Browser analytics",
  message:
    "Cloudflare Web Analytics uses a browser beacon; no server conversion status is expected.",
};

const NOT_APPLICABLE_CUSTOM: AnalyticsProviderServerReadiness = {
  status: "not_applicable",
  configured: false,
  label: "Custom browser",
  message:
    "Custom snippets are not inspected for server-side conversion readiness.",
};

const NOT_CONFIGURED_META_CAPI: AnalyticsProviderServerReadiness = {
  status: "not_configured",
  configured: false,
  label: "Server not configured",
  message: "Meta CAPI is not enabled.",
};

const PROVIDERS: ProviderDefinition[] = [
  {
    provider: "google_analytics",
    label: "Google Analytics 4",
    defaultServerSide: BROWSER_ONLY_GOOGLE_ANALYTICS,
  },
  {
    provider: "google_tag_manager",
    label: "Google Tag Manager",
    defaultServerSide: BROWSER_ONLY_GOOGLE_TAG_MANAGER,
  },
  {
    provider: "facebook_pixel",
    label: "Facebook Pixel",
    defaultServerSide: NOT_CONFIGURED_META_CAPI,
  },
  {
    provider: "tiktok_pixel",
    label: "TikTok Pixel",
    defaultServerSide: BROWSER_ONLY_TIKTOK_PIXEL,
  },
  {
    provider: "cloudflare_web_analytics",
    label: "Cloudflare Web Analytics",
    defaultServerSide: NOT_APPLICABLE_CLOUDFLARE,
  },
  {
    provider: "custom",
    label: "Custom Script",
    defaultServerSide: NOT_APPLICABLE_CUSTOM,
  },
];

function isAnalyticsScriptType(type: string | null | undefined): type is AnalyticsScriptType {
  return typeof type === "string" && analyticsScriptTypes.includes(type as AnalyticsScriptType);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function extractCloudflareWebAnalyticsToken(config: string): string | null {
  if (!config.includes(CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC)) {
    return null;
  }

  const beaconMatch = config.match(/data-cf-beacon\s*=\s*(["'])(.*?)\1/is);
  if (!beaconMatch?.[2]) {
    return null;
  }

  try {
    const beaconConfig = JSON.parse(beaconMatch[2]) as { token?: unknown };
    return typeof beaconConfig.token === "string" ? beaconConfig.token : null;
  } catch {
    return null;
  }
}

function isValidCloudflareWebAnalyticsToken(token: string): boolean {
  return (
    token !== CLOUDFLARE_WEB_ANALYTICS_TOKEN_PLACEHOLDER &&
    CLOUDFLARE_WEB_ANALYTICS_TOKEN_PATTERN.test(token)
  );
}

function getCloudflareWebAnalyticsConfigError(config: string): string | null {
  const trimmedConfig = config.trim();
  if (!trimmedConfig) {
    return "Active analytics scripts must include a saved browser snippet.";
  }

  if (/<script/i.test(trimmedConfig)) {
    const token = extractCloudflareWebAnalyticsToken(trimmedConfig);
    return token && isValidCloudflareWebAnalyticsToken(token)
      ? null
      : "Active Cloudflare Web Analytics scripts must use a valid site token or official beacon snippet.";
  }

  return isValidCloudflareWebAnalyticsToken(trimmedConfig)
    ? null
    : "Active Cloudflare Web Analytics scripts must use a valid site token or official beacon snippet.";
}

function getActiveScriptIssue(script: AnalyticsProviderHealthScript): string | null {
  if (!script.isActive) {
    return null;
  }

  const config = script.config ?? "";
  if (!config.trim()) {
    return "Active analytics scripts must include a saved browser snippet.";
  }

  if (!isAnalyticsScriptType(script.type)) {
    return "Active analytics scripts must use a supported provider type.";
  }

  return (
    getActiveAnalyticsConfigError({
      type: script.type,
      config,
      isActive: true,
    }) ??
    (script.type === "cloudflare_web_analytics"
      ? getCloudflareWebAnalyticsConfigError(config)
      : null)
  );
}

function buildBrowserReadiness(
  provider: AnalyticsScriptType,
  scripts: AnalyticsProviderHealthScript[],
): AnalyticsProviderBrowserReadiness {
  const providerScripts = scripts.filter((script) => script.type === provider);
  const activeScripts = providerScripts.filter((script) => script.isActive === true);
  const draftScriptCount = providerScripts.length - activeScripts.length;
  const issues = unique(
    activeScripts
      .map(getActiveScriptIssue)
      .filter((issue): issue is string => Boolean(issue)),
  );
  const blockedScriptCount = activeScripts.filter((script) =>
    Boolean(getActiveScriptIssue(script)),
  ).length;
  const readyScriptCount = activeScripts.length - blockedScriptCount;

  if (blockedScriptCount > 0) {
    return {
      status: "blocked",
      configured: false,
      activeScriptCount: activeScripts.length,
      readyScriptCount,
      draftScriptCount,
      blockedScriptCount,
      message:
        blockedScriptCount === 1
          ? "One active browser snippet needs attention before it can be trusted."
          : `${blockedScriptCount} active browser snippets need attention before they can be trusted.`,
      issues,
    };
  }

  if (readyScriptCount > 0) {
    return {
      status: "ready",
      configured: true,
      activeScriptCount: activeScripts.length,
      readyScriptCount,
      draftScriptCount,
      blockedScriptCount,
      message:
        readyScriptCount === 1
          ? "One active browser snippet is configured."
          : `${readyScriptCount} active browser snippets are configured.`,
      issues: [],
    };
  }

  if (draftScriptCount > 0) {
    return {
      status: "draft",
      configured: false,
      activeScriptCount: 0,
      readyScriptCount: 0,
      draftScriptCount,
      blockedScriptCount: 0,
      message:
        draftScriptCount === 1
          ? "One inactive draft is saved."
          : `${draftScriptCount} inactive drafts are saved.`,
      issues: [],
    };
  }

  return {
    status: "not_configured",
    configured: false,
    activeScriptCount: 0,
    readyScriptCount: 0,
    draftScriptCount: 0,
    blockedScriptCount: 0,
    message: "No browser snippet is saved for this provider.",
    issues: [],
  };
}

export async function buildMetaCapiServerSideReadiness(
  settings: MetaCapiSettingsForHealth | null | undefined,
  credentialEncryptionKey?: string,
): Promise<AnalyticsProviderServerReadiness> {
  if (!settings?.isEnabled) {
    return NOT_CONFIGURED_META_CAPI;
  }

  const pixelId = settings.pixelId?.trim() ?? "";
  const accessTokenRead = await readStoredCredentialStrict(
    settings.accessToken,
    credentialEncryptionKey,
    "Meta Conversions API access token",
  );

  if (accessTokenRead.error) {
    return {
      status: "blocked",
      configured: false,
      label: "Server blocked",
      message:
        "Meta CAPI is enabled but the saved access token cannot be read with the configured credential key.",
    };
  }

  const missingFields = [
    pixelId ? null : "Pixel ID",
    accessTokenRead.value ? null : "access token",
  ].filter((field): field is string => Boolean(field));

  if (missingFields.length > 0) {
    return {
      status: "blocked",
      configured: false,
      label: "Server blocked",
      message: `Meta CAPI is enabled but missing a readable ${missingFields.join(" and ")}.`,
    };
  }

  if (!META_PIXEL_ID_PATTERN.test(pixelId)) {
    return {
      status: "blocked",
      configured: false,
      label: "Server blocked",
      message:
        "Meta CAPI is enabled but the saved Pixel ID is not a numeric Meta Pixel ID.",
    };
  }

  return {
    status: "ready",
    configured: true,
    label: "Server ready",
    message:
      "Meta CAPI is enabled with a readable Pixel ID and access token. No provider test event was sent.",
  };
}

export function buildAnalyticsProviderHealth(
  scripts: AnalyticsProviderHealthScript[],
  options: BuildAnalyticsProviderHealthOptions = {},
): AnalyticsProviderHealthResponse {
  const providers = PROVIDERS.map((definition) => ({
    provider: definition.provider,
    label: definition.label,
    browser: buildBrowserReadiness(definition.provider, scripts),
    serverSide:
      definition.provider === "facebook_pixel"
        ? options.metaServerSide ?? NOT_CONFIGURED_META_CAPI
        : definition.defaultServerSide,
  }));

  return {
    summary: {
      totalProviders: providers.length,
      browserReadyProviders: providers.filter((item) => item.browser.status === "ready").length,
      draftProviders: providers.filter((item) => item.browser.status === "draft").length,
      blockedProviders: providers.filter((item) => item.browser.status === "blocked").length,
      notConfiguredProviders: providers.filter(
        (item) => item.browser.status === "not_configured",
      ).length,
      serverReadyProviders: providers.filter((item) => item.serverSide.status === "ready").length,
    },
    providers,
  };
}

export async function getAnalyticsProviderHealth(
  db: Database,
  options: GetAnalyticsProviderHealthOptions = {},
): Promise<AnalyticsProviderHealthResponse> {
  const [scripts, metaSettings] = await Promise.all([
    db
      .select({
        type: analytics.type,
        config: analytics.config,
        isActive: analytics.isActive,
      })
      .from(analytics)
      .all(),
    db
      .select({
        pixelId: metaConversionsSettings.pixelId,
        accessToken: metaConversionsSettings.accessToken,
        isEnabled: metaConversionsSettings.isEnabled,
      })
      .from(metaConversionsSettings)
      .where(eq(metaConversionsSettings.id, "singleton"))
      .get(),
  ]);

  const metaServerSide = await buildMetaCapiServerSideReadiness(
    metaSettings,
    options.credentialEncryptionKey,
  );

  return buildAnalyticsProviderHealth(scripts, { metaServerSide });
}
