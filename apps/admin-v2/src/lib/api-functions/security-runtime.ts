import { createServerFn } from "@tanstack/react-start";
import { normalizePlatformOrigin } from "@scalius/shared/security-csp";

export type InheritedSecuritySourceKind =
  | "storefront"
  | "api"
  | "dashboard"
  | "media";

export interface InheritedSecuritySource {
  key: string;
  label: string;
  kind: InheritedSecuritySourceKind;
  source: string | null;
  consequence: string;
}

function configuredSource(
  key: string,
  label: string,
  kind: InheritedSecuritySourceKind,
  raw: unknown,
  consequence: string,
): InheritedSecuritySource {
  return {
    key,
    label,
    kind,
    source: normalizePlatformOrigin(raw),
    consequence,
  };
}

export const getInheritedSecuritySources = createServerFn({
  method: "GET",
}).handler(async (): Promise<InheritedSecuritySource[]> => {
  const { env } = await import("cloudflare:workers");
  const workerEnv = env as Env;

  return [
    configuredSource(
      "storefront",
      "Storefront",
      "storefront",
      workerEnv.STOREFRONT_URL,
      "The storefront trusts its own origin by default.",
    ),
    configuredSource(
      "api",
      "Commerce API",
      "api",
      workerEnv.PUBLIC_API_BASE_URL,
      "Buyer requests can connect to this exact API origin.",
    ),
    configuredSource(
      "dashboard",
      "Admin dashboard",
      "dashboard",
      workerEnv.BETTER_AUTH_URL,
      "Admin sessions and credentialed API requests recognize this exact origin.",
    ),
    configuredSource(
      "cdn",
      "Canonical media CDN",
      "media",
      workerEnv.CDN_DOMAIN_URL,
      "Storefront images can load from this exact media origin.",
    ),
    configuredSource(
      "r2",
      "Public media storage",
      "media",
      workerEnv.R2_PUBLIC_URL,
      "Existing public media can load from this exact storage origin.",
    ),
  ];
});
