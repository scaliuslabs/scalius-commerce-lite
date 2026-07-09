export const STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER =
  "x-scalius-storefront-client-ip";
export const STOREFRONT_CHAT_ANONYMOUS_RATE_LIMIT_BUCKET = "anonymous";
export const STOREFRONT_CHAT_CLIENT_IP_MAX_LENGTH = 64;

/**
 * Accept one canonical IP address only. This deliberately rejects proxy lists,
 * ports, zone identifiers, and arbitrary text before a value crosses the
 * Storefront -> API service-binding boundary.
 */
export function normalizeStorefrontChatClientIp(
  value: string | null | undefined,
): string | null {
  const candidate = value?.trim();
  if (
    !candidate ||
    candidate.length > STOREFRONT_CHAT_CLIENT_IP_MAX_LENGTH ||
    candidate.includes(",") ||
    candidate.includes("%") ||
    candidate.includes("[") ||
    candidate.includes("]")
  ) {
    return null;
  }

  const ipv4 = normalizeIpv4(candidate);
  if (ipv4) return ipv4;
  return normalizeIpv6(candidate);
}

/**
 * Build the ephemeral identity given to the keyed HMAC limiter. IPv6 clients
 * share a /64 bucket so address rotation inside one ordinary client prefix
 * cannot trivially bypass the public assistant limit.
 */
export function storefrontChatRateLimitBucketFromIp(
  value: string | null | undefined,
): string | null {
  const ip = normalizeStorefrontChatClientIp(value);
  if (!ip) return null;
  if (!ip.includes(":")) return `ipv4:${ip}`;

  const hextets = expandIpv6(ip);
  return hextets
    ? `ipv6:${hextets.slice(0, 4).join(":")}/64`
    : null;
}

function normalizeIpv4(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const normalized: string[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet < 0 || octet > 255 || String(octet) !== part) return null;
    normalized.push(String(octet));
  }
  return normalized.join(".");
}

function normalizeIpv6(value: string): string | null {
  if (!value.includes(":")) return null;

  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function expandIpv6(value: string): string[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return null;
  }

  const expanded = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (expanded.length !== 8) return null;
  return expanded.map((part) => part.padStart(4, "0"));
}
