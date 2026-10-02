// Server-side request forgery guard for merchant- or plugin-supplied URLs the
// API Worker calls (webhook endpoints, later the plugin bridge's http.fetch).
//
// Resolve-free: it inspects the URL as parsed (WHATWG URL already turns
// integer, octal and hex IPv4 forms into dotted quads and compresses IPv6), so
// a literal private, loopback, link-local, unique-local, multicast, reserved
// or IPv4-mapped address is refused before any request. Hostnames are not
// resolved here; the Workers runtime cannot reach private networks, and every
// call must also use `redirect: "manual"` so a public host cannot bounce the
// request to a private one.

export const OUTBOUND_URL_MAX_LENGTH = 2048;

export type OutboundUrlIssue =
  | "invalid_url"
  | "not_https"
  | "credentials"
  | "fragment"
  | "too_long"
  | "blocked_host"
  | "private_address";

export type OutboundUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; issue: OutboundUrlIssue };

/** Hostnames that name the local machine or a private network by convention. */
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".home.arpa",
  ".in-addr.arpa",
  ".ip6.arpa",
] as const;
const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata", "metadata.google.internal"]);

/** IPv4 ranges that never belong to a public webhook receiver. [base, prefix length] */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function ipv4InRange(address: number, base: string, prefix: number): boolean {
  const baseValue = parseIpv4(base)!;
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(baseValue / size);
}

export function isBlockedIpv4(host: string): boolean {
  const address = parseIpv4(host);
  if (address === null) return false;
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) => ipv4InRange(address, base, prefix));
}

/** Eight 16-bit groups of an IPv6 literal (brackets optional), or null. */
export function parseIpv6(input: string): number[] | null {
  let host = input.trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone);
  if (!host.includes(":")) return null;

  // A trailing dotted IPv4 (::ffff:127.0.0.1) becomes two groups.
  const lastColon = host.lastIndexOf(":");
  const tail = host.slice(lastColon + 1);
  if (tail.includes(".")) {
    const ipv4 = parseIpv4(tail);
    if (ipv4 === null) return null;
    host = `${host.slice(0, lastColon + 1)}${Math.floor(ipv4 / 65536).toString(16)}:${(ipv4 % 65536).toString(16)}`;
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parseGroups(halves[0]!);
  const rest = halves.length === 2 ? parseGroups(halves[1]!) : [];
  const groups = halves.length === 2
    ? [...head, ...Array(Math.max(0, 8 - head.length - rest.length)).fill("0"), ...rest]
    : head;
  if (groups.length !== 8) return null;
  const values: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    values.push(parseInt(group, 16));
  }
  return values;
}

export function isBlockedIpv6(host: string): boolean {
  const groups = parseIpv6(host);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // :: and ::1
  if (firstFiveZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): the
  // embedded address is IPv4 in IPv6 clothing; never a webhook receiver.
  if (firstFiveZero && (g5 === 0xffff || g5 === 0)) return true;
  // IPv4-translated (::ffff:0:a.b.c.d)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if (g0 === 0x64 && g1 === 0xff9b) return true;
  // Discard-only 100::/64
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // Teredo 2001::/32, documentation 2001:db8::/32, 6to4 2002::/16
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;
  if (g0 === 0x2002) return true;
  // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xffc0) === 0xfec0) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // A single-label name resolves through search domains to internal hosts.
  return !host.includes(".");
}

/**
 * Checks a URL the API Worker is about to call on a merchant's behalf.
 * HTTPS only, no embedded credentials or fragment, at most 2048 characters,
 * and a host that is neither a blocked name nor a non-public IP literal.
 */
export function checkOutboundUrl(value: unknown): OutboundUrlCheck {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, issue: "invalid_url" };
  const raw = value.trim();
  if (raw.length > OUTBOUND_URL_MAX_LENGTH) return { ok: false, issue: "too_long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, issue: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, issue: "not_https" };
  if (url.username || url.password) return { ok: false, issue: "credentials" };
  if (url.hash || raw.includes("#")) return { ok: false, issue: "fragment" };
  const hostname = url.hostname;
  if (hostname.startsWith("[")) {
    return isBlockedIpv6(hostname) ? { ok: false, issue: "private_address" } : { ok: true, url };
  }
  if (parseIpv4(hostname) !== null) {
    return isBlockedIpv4(hostname) ? { ok: false, issue: "private_address" } : { ok: true, url };
  }
  if (isBlockedHostname(hostname)) return { ok: false, issue: "blocked_host" };
  return { ok: true, url };
}

/** Plain-language reason for a refused URL (dashboard and API errors). */
export function describeOutboundUrlIssue(issue: OutboundUrlIssue): string {
  switch (issue) {
    case "invalid_url":
      return "Enter a full URL, like https://example.com/webhooks.";
    case "not_https":
      return "The URL must start with https://.";
    case "credentials":
      return "Remove the username and password from the URL.";
    case "fragment":
      return "Remove the # part from the URL.";
    case "too_long":
      return `The URL must be at most ${OUTBOUND_URL_MAX_LENGTH} characters.`;
    case "blocked_host":
      return "The URL must point to a public internet host.";
    case "private_address":
      return "The URL must not point to a private, local or reserved network address.";
  }
}
