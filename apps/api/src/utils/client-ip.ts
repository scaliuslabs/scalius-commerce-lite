export interface ClientIpRuntime {
  req: { header: (name: string) => string | undefined; url: string };
  env: {
    PUBLIC_API_BASE_URL?: string;
    BETTER_AUTH_URL?: string;
    STOREFRONT_URL?: string;
  };
}

export function getTrustedClientIp(c: ClientIpRuntime): string {
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
