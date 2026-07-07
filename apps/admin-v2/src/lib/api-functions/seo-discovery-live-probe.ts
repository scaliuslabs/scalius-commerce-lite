import {
  SEO_DISCOVERY_LIVE_PROBE_ENDPOINTS,
  SEO_DISCOVERY_SITEMAP_CHILD_PROBE_ENDPOINTS,
  buildSeoDiscoveryHref,
  normalizeSeoDiscoverySettingsWithReturnPolicy,
  parseSeoDiscoveryStorefrontUrl,
  summarizeSeoDiscoveryProbeBody,
  type SeoDiscoveryLiveProbeKind,
  type SeoDiscoveryLiveProbeKey,
  type SeoDiscoveryLiveProbeResource,
  type SeoDiscoveryLiveProbeResult,
} from "../seo-discovery-status";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface StorefrontUrlPayload {
  storefrontUrl: string;
}

export interface SeoDiscoveryPolicyPayload {
  discovery?: unknown;
}

interface BoundedTextRead {
  text: string;
  truncated: boolean;
}

export interface SeoDiscoveryLiveProbeDeps {
  fetch?: typeof fetch;
  getDiscoveryPolicy?: () => Promise<SeoDiscoveryPolicyPayload>;
  getStorefrontUrl?: () => Promise<StorefrontUrlPayload>;
  maxBodyBytes?: number;
  now?: () => Date;
  timeoutMs?: number;
}

interface ProbeTarget {
  key: SeoDiscoveryLiveProbeKey;
  kind: SeoDiscoveryLiveProbeKind;
  label: string;
  path: string;
  disabledReason?: string;
  expectedRobotsSitemapLines?: number;
  minimumSitemapLocs?: number;
}

function safeHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 160);
}

async function readBoundedResponseText(
  response: Response,
  maxBodyBytes: number,
): Promise<BoundedTextRead> {
  if (!response.body) {
    return { text: "", truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBodyBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }

      if (value.byteLength > remaining) {
        chunks.push(
          decoder.decode(value.slice(0, remaining), { stream: true }),
        );
        bytesRead += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(decoder.decode(value, { stream: true }));
      bytesRead += value.byteLength;
    }
  } finally {
    chunks.push(decoder.decode());
  }

  return { text: chunks.join(""), truncated };
}

function formatProbeFailure(didTimeout: boolean, timeoutMs: number): string {
  if (didTimeout) {
    return `Timed out after ${Math.ceil(timeoutMs / 1000)}s.`;
  }
  return "Fetch failed.";
}

function formatHttpFailure(status: number): string | undefined {
  if (status >= 300 && status < 400) {
    return "Redirect blocked.";
  }
  if (status < 200 || status >= 300) {
    return `HTTP ${status}`;
  }
  return undefined;
}

function disabledProbeResource(
  target: ProbeTarget,
  baseUrl: URL,
): SeoDiscoveryLiveProbeResource {
  return {
    key: target.key,
    kind: target.kind,
    label: target.label,
    path: target.path,
    href: buildSeoDiscoveryHref(baseUrl, target.path),
    ok: true,
    status: null,
    contentType: null,
    cacheControl: null,
    counts: {},
    disabledReason: target.disabledReason,
    expectedRobotsSitemapLines: target.expectedRobotsSitemapLines,
    minimumSitemapLocs: target.minimumSitemapLocs,
  };
}

async function probeEndpoint({
  baseUrl,
  fetchImpl,
  maxBodyBytes,
  target,
  timeoutMs,
}: {
  baseUrl: URL;
  fetchImpl: typeof fetch;
  maxBodyBytes: number;
  target: ProbeTarget;
  timeoutMs: number;
}): Promise<SeoDiscoveryLiveProbeResource> {
  if (target.disabledReason) {
    return disabledProbeResource(target, baseUrl);
  }

  const { key, kind, label, path } = target;
  const href = buildSeoDiscoveryHref(baseUrl, path);
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(href, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1",
      },
    });
    const body = await readBoundedResponseText(response, maxBodyBytes);
    const error = formatHttpFailure(response.status);

    return {
      key,
      kind,
      label,
      path,
      href,
      ok: response.ok,
      status: response.status,
      contentType: safeHeaderValue(response.headers.get("content-type")),
      cacheControl: safeHeaderValue(response.headers.get("cache-control")),
      counts: summarizeSeoDiscoveryProbeBody(key, body.text),
      bodyTruncated: body.truncated || undefined,
      error,
      expectedRobotsSitemapLines: target.expectedRobotsSitemapLines,
      minimumSitemapLocs: target.minimumSitemapLocs,
    };
  } catch {
    return {
      key,
      kind,
      label,
      path,
      href,
      ok: false,
      status: null,
      contentType: null,
      cacheControl: null,
      counts: {},
      error: formatProbeFailure(didTimeout, timeoutMs),
      expectedRobotsSitemapLines: target.expectedRobotsSitemapLines,
      minimumSitemapLocs: target.minimumSitemapLocs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function countEnabledSitemapSections(
  sitemap: ReturnType<
    typeof normalizeSeoDiscoverySettingsWithReturnPolicy
  >["sitemap"],
): number {
  return SEO_DISCOVERY_SITEMAP_CHILD_PROBE_ENDPOINTS.filter(
    ([, , , sectionKey]) => sitemap[sectionKey],
  ).length;
}

function buildProbeTargets(discoveryValue: unknown): ProbeTarget[] {
  const discovery = normalizeSeoDiscoverySettingsWithReturnPolicy(discoveryValue);
  const targets: ProbeTarget[] = SEO_DISCOVERY_LIVE_PROBE_ENDPOINTS.map(
    ([key, label, path, kind]) => {
      if (kind === "robots") {
        return {
          key,
          kind,
          label,
          path,
          expectedRobotsSitemapLines:
            discovery.sitemap.enabled && discovery.robots.advertiseSitemap
              ? 1
              : 0,
        };
      }

      if (kind === "sitemap") {
        return {
          key,
          kind,
          label,
          path,
          minimumSitemapLocs: discovery.sitemap.enabled
            ? countEnabledSitemapSections(discovery.sitemap)
            : 0,
        };
      }

      return {
        key,
        kind,
        label,
        path,
        disabledReason: discovery.feeds.productCatalogEnabled
          ? undefined
          : "Catalog feeds are disabled by the current SEO discovery policy.",
      };
    },
  );

  for (const [
    key,
    label,
    path,
    sectionKey,
  ] of SEO_DISCOVERY_SITEMAP_CHILD_PROBE_ENDPOINTS) {
    const enabled = discovery.sitemap.enabled && discovery.sitemap[sectionKey];
    targets.push({
      key,
      kind: "sitemapChild",
      label,
      path,
      disabledReason: enabled
        ? undefined
        : "This sitemap section is disabled by the current SEO discovery policy.",
      minimumSitemapLocs: sectionKey === "staticPages" && enabled ? 1 : 0,
    });
  }

  return targets;
}

export async function runSeoDiscoveryLiveProbe(
  deps: SeoDiscoveryLiveProbeDeps = {},
): Promise<SeoDiscoveryLiveProbeResult> {
  const timeoutMs = Math.min(
    Math.max(Math.trunc(deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS), 1_000),
    12_000,
  );
  const maxBodyBytes = Math.max(
    1,
    Math.trunc(deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES),
  );
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const getStorefrontUrl = deps.getStorefrontUrl;
  if (!getStorefrontUrl) {
    return {
      baseUrl: null,
      checkedAt,
      ok: false,
      error: "Store URL lookup is not configured.",
      resources: [],
    };
  }
  const fetchImpl = deps.fetch ?? fetch;
  const { storefrontUrl } = await getStorefrontUrl();
  const baseUrl = parseSeoDiscoveryStorefrontUrl(storefrontUrl);

  if (!baseUrl) {
    return {
      baseUrl: null,
      checkedAt,
      ok: false,
      error: "Store URL must be an absolute http(s) URL.",
      resources: [],
    };
  }

  const policyPayload = deps.getDiscoveryPolicy
    ? await deps.getDiscoveryPolicy()
    : { discovery: undefined };
  const probeTargets = buildProbeTargets(policyPayload.discovery);
  const resources = await Promise.all(
    probeTargets.map((target) =>
      probeEndpoint({
        baseUrl,
        fetchImpl,
        maxBodyBytes,
        target,
        timeoutMs,
      }),
    ),
  );

  return {
    baseUrl: baseUrl.href,
    checkedAt,
    ok: resources.every((resource) => resource.ok),
    resources,
  };
}
