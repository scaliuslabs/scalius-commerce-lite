type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };

const COOKIE_NAME_PREFIX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=+/;

function looksLikeCookieStart(value: string): boolean {
  return COOKIE_NAME_PREFIX.test(value.trimStart());
}

function splitCombinedSetCookieHeader(header: string): string[] {
  const cookies: string[] = [];
  let start = 0;
  let inExpires = false;

  for (let i = 0; i < header.length; i++) {
    const remaining = header.slice(i).toLowerCase();
    if (!inExpires && remaining.startsWith("expires=")) {
      inExpires = true;
    }

    const char = header[i];
    if (inExpires && char === ";") {
      inExpires = false;
      continue;
    }

    if (char !== ",") continue;

    const next = header.slice(i + 1);
    if (!looksLikeCookieStart(next)) continue;

    const current = header.slice(start, i).trim();
    const expiresEndedAtComma = inExpires && /expires=[^;]*gmt$/i.test(current);
    if (!inExpires || expiresEndedAtComma) {
      if (current) cookies.push(current);
      start = i + 1;
      inExpires = false;
    }
  }

  const last = header.slice(start).trim();
  if (last) cookies.push(last);
  return cookies;
}

export function getSetCookieHeaderValues(headers: Headers): string[] {
  const headersWithCookies = headers as HeadersWithSetCookie;
  if (typeof headersWithCookies.getSetCookie === "function") {
    return headersWithCookies.getSetCookie();
  }

  const combined = headers.get("set-cookie");
  return combined ? splitCombinedSetCookieHeader(combined) : [];
}

export function rewriteCustomerAuthSetCookie(cookie: string): string {
  const withoutDomain = cookie.replace(/;\s*Domain=[^;]*/gi, "");
  if (/;\s*SameSite=/i.test(withoutDomain)) {
    return withoutDomain.replace(/;\s*SameSite=None/gi, "; SameSite=Lax");
  }
  return `${withoutDomain}; SameSite=Lax`;
}

export function appendRewrittenCustomerAuthSetCookies(
  targetHeaders: Headers,
  sourceHeaders: Headers,
): void {
  for (const cookie of getSetCookieHeaderValues(sourceHeaders)) {
    targetHeaders.append("Set-Cookie", rewriteCustomerAuthSetCookie(cookie));
  }
}

export { splitCombinedSetCookieHeader };
