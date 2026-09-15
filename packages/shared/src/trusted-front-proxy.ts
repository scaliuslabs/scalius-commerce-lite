/**
 * Trusted front-proxy headers.
 *
 * When a routing Worker or reverse proxy sits in front of the API, dashboard,
 * and storefront Workers, the runtime sees the proxy's hostname as `Host` and
 * the proxy's address as the client IP. `X-Forwarded-Host`,
 * `X-Forwarded-Proto`, and `X-Forwarded-For` are honoured only when the
 * request also carries `X-Scalius-Proxy-Signature`: an HMAC-SHA256 over the
 * forwarded proto, host, request path, client IP, and a timestamp, keyed with
 * the HKDF-derived `FRONT_PROXY_SECRET` (label `front-proxy`). Anything else
 * leaves the request untouched, so an unsigned or stale header can never
 * change canonical URLs, cookie-origin checks, or rate-limit identity.
 *
 * Header format (one line):
 *
 *   X-Scalius-Proxy-Signature: v1,t=<unix seconds>,s=<base64url HMAC>
 *
 * Signed payload (newline separated, no trailing newline):
 *
 *   v1\n<unix seconds>\n<proto>\n<host>\n<pathname>\n<client ip or empty>
 *
 * `proto` is `http` or `https`, `host` is the public `host[:port]`, `pathname`
 * is the request path as the proxy forwarded it (no query string), and the
 * client IP is the first address in `X-Forwarded-For` (empty when the proxy
 * does not forward one). Signatures older or newer than five minutes are
 * rejected. This module is dependency-free so every Worker entry shares it.
 */

export const FRONT_PROXY_SIGNATURE_HEADER = "X-Scalius-Proxy-Signature";
export const FRONT_PROXY_SIGNATURE_VERSION = "v1";
export const FRONT_PROXY_MAX_CLOCK_SKEW_SECONDS = 300;

const FORWARDED_HOST_HEADER = "X-Forwarded-Host";
const FORWARDED_PROTO_HEADER = "X-Forwarded-Proto";
const FORWARDED_FOR_HEADER = "X-Forwarded-For";
/** The header every Worker (and Better Auth) already reads for the client IP. */
const CLIENT_IP_HEADER = "cf-connecting-ip";

const encoder = new TextEncoder();

export type ForwardedProto = "http" | "https";

export interface FrontProxySigningInput {
  timestamp: number;
  proto: ForwardedProto;
  host: string;
  pathname: string;
  clientIp: string | null;
}

export interface TrustedFrontProxyResult {
  /** The request to continue with; identical to the input when untrusted. */
  request: Request;
  /** True only when a valid, fresh signature covered the forwarded values. */
  trusted: boolean;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

/** Hostname[:port] with the same shape rules Better Auth applies to proxies. */
export function isValidForwardedHost(value: string): boolean {
  if (!value || value.length > 255) return false;
  if (/[\s<>'"\\/\0]|\.\./.test(value)) return false;
  return (
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/i.test(value)
    || /^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(value)
  );
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
  if (!value.includes(":") || /[^0-9a-f:.]/i.test(value)) return false;
  try {
    new URL(`http://[${value}]`);
    return true;
  } catch {
    return false;
  }
}

/** The first `X-Forwarded-For` address when it is a syntactically valid IP. */
export function firstForwardedClientIp(header: string | null | undefined): string | null {
  if (!header) return null;
  const first = header.split(",")[0]?.trim() ?? "";
  if (!first) return null;
  return isValidIpv4(first) || isValidIpv6(first) ? first : null;
}

export function buildFrontProxySigningPayload(input: FrontProxySigningInput): string {
  return [
    FRONT_PROXY_SIGNATURE_VERSION,
    String(input.timestamp),
    input.proto,
    input.host,
    input.pathname,
    input.clientIp ?? "",
  ].join("\n");
}

async function hmacBase64Url(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return encodeBase64Url(new Uint8Array(signature));
}

/** Produces the header value a front proxy sends. Used by proxies, tooling, and tests. */
export async function signFrontProxyRequest(
  secret: string,
  input: FrontProxySigningInput,
): Promise<string> {
  const signature = await hmacBase64Url(secret, buildFrontProxySigningPayload(input));
  return `${FRONT_PROXY_SIGNATURE_VERSION},t=${input.timestamp},s=${signature}`;
}

export interface ParsedFrontProxySignature {
  timestamp: number;
  signature: string;
}

export function parseFrontProxySignature(
  header: string | null | undefined,
): ParsedFrontProxySignature | null {
  if (!header) return null;
  const match = /^v1,t=(\d{1,12}),s=([A-Za-z0-9_-]{43})$/.exec(header.trim());
  if (!match) return null;
  return { timestamp: Number.parseInt(match[1]!, 10), signature: match[2]! };
}

export interface ApplyTrustedFrontProxyOptions {
  /** Unix seconds; injectable for tests. */
  nowSeconds?: () => number;
}

function readForwardedProto(value: string | null): ForwardedProto | null {
  const proto = value?.trim().toLowerCase();
  return proto === "http" || proto === "https" ? proto : null;
}

/**
 * Returns a request whose URL and client IP reflect the forwarded values when
 * (and only when) the proxy signature is valid. `secret` is the derived
 * `FRONT_PROXY_SECRET`; pass `null` when the master secret is not installed so
 * the headers are ignored.
 */
export async function applyTrustedFrontProxy(
  request: Request,
  secret: string | null | undefined,
  options: ApplyTrustedFrontProxyOptions = {},
): Promise<TrustedFrontProxyResult> {
  const untrusted: TrustedFrontProxyResult = { request, trusted: false };
  const parsed = parseFrontProxySignature(request.headers.get(FRONT_PROXY_SIGNATURE_HEADER));
  if (!parsed || !secret) return untrusted;

  const now = options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > FRONT_PROXY_MAX_CLOCK_SKEW_SECONDS) return untrusted;

  const host = request.headers.get(FORWARDED_HOST_HEADER)?.trim().toLowerCase() ?? "";
  const proto = readForwardedProto(request.headers.get(FORWARDED_PROTO_HEADER));
  if (!proto || !isValidForwardedHost(host)) return untrusted;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return untrusted;
  }
  const clientIp = firstForwardedClientIp(request.headers.get(FORWARDED_FOR_HEADER));
  const expected = await hmacBase64Url(
    secret,
    buildFrontProxySigningPayload({
      timestamp: parsed.timestamp,
      proto,
      host,
      pathname: url.pathname,
      clientIp,
    }),
  );
  if (!constantTimeEqual(expected, parsed.signature)) return untrusted;

  url.protocol = `${proto}:`;
  url.host = host;
  const forwarded = new Request(url.toString(), request);
  if (clientIp) forwarded.headers.set(CLIENT_IP_HEADER, clientIp);
  return { request: forwarded, trusted: true };
}
