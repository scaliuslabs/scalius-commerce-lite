import { rateLimitIpSubject } from "@scalius/shared/rate-limit";

/**
 * The one reader of the client-address headers in the API. Every limiter
 * subject comes from getTrustedClientIp, which groups IPv6 by /64.
 */
export interface ClientIpRuntime {
  req: { header: (name: string) => string | undefined; url: string };
  env: {
    PUBLIC_API_BASE_URL?: string;
    BETTER_AUTH_URL?: string;
    STOREFRONT_URL?: string;
  };
}

/**
 * The rate-limit subject of the caller: its trusted address (see
 * getTrustedClientAddress), with an IPv6 address grouped by its /64.
 */
export function getTrustedClientIp(c: ClientIpRuntime): string {
  return rateLimitIpSubject(getTrustedClientAddress(c));
}

/** getTrustedClientIp for code that holds a Request and the Worker env rather than a Hono context. */
export function getTrustedClientIpFromRequest(request: Request, env: ClientIpRuntime["env"]): string {
  return getTrustedClientIp({ req: { header: (name) => request.headers.get(name) ?? undefined, url: request.url }, env });
}

/**
 * A log-safe form of the caller's network, never its address: an IPv4 address
 * as its /24, an IPv6 address as its /48.
 */
export function getClientNetworkForLog(c: ClientIpRuntime): string {
  const subject = getTrustedClientIp(c);
  const ipv4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(subject);
  if (ipv4) return `${ipv4[1]}.0/24`;
  const ipv6 = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(subject);
  if (ipv6) return `${ipv6[1]}::/48`;
  return "unknown";
}

/**
 * The caller's literal address:`cf-connecting-ip` only, or the first
 * `x-forwarded-for` address when a platform origin is loopback (local dev);
 * otherwise `unknown`. Not a limiter subject: use getTrustedClientIp.
 */
export function getTrustedClientAddress(c: ClientIpRuntime): string {
  const cloudflareIp = normalizeSingleIp(c.req.header("cf-connecting-ip"));
  if (cloudflareIp) return cloudflareIp;

  const runtimeOrigins = [
    c.env.PUBLIC_API_BASE_URL,
    c.env.BETTER_AUTH_URL,
    c.env.STOREFRONT_URL,
    new URL(c.req.url).origin,
  ];
  if (runtimeOrigins.some(isLoopbackOrigin)) {
    return firstForwardedIp(c.req.header("x-forwarded-for")) ?? "unknown";
  }

  return "unknown";
}

function firstForwardedIp(value: string | undefined): string | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    const ip = normalizeSingleIp(part);
    if (ip) return ip;
  }
  return null;
}

function normalizeSingleIp(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes(",")) return null;
  if (isValidIpv4(trimmed) || isValidIpv6(trimmed)) return trimmed;
  return null;
}

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const parsed = Number.parseInt(part, 10);
    return parsed >= 0 && parsed <= 255 && String(parsed) === part;
  });
}

function isValidIpv6(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    new URL(`http://[${value.replace(/^\[|\]$/g, "")}]`);
    return true;
  } catch {
    return false;
  }
}

function isLoopbackOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}
