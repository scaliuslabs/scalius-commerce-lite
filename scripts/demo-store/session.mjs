import { buildCookieHeader, extractSetCookieHeaders } from "../admin-session-cookie.mjs";

const MAX_AUTH_RESPONSE_BYTES = 256_000;

export function normalizeAdminOrigin(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("Admin URL must be a valid origin.");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Admin URL must be an origin without credentials, path, query, or fragment.");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Admin URL must use HTTPS (HTTP is allowed only on loopback).");
  }
  return url.origin;
}

async function boundedJson(response, label) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_AUTH_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`${label} response exceeded the safe size limit.`);
  }
  const text = await response.text();
  if (text.length > MAX_AUTH_RESPONSE_BYTES) throw new Error(`${label} response exceeded the safe size limit.`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} response was not valid JSON.`);
  }
}

async function request(fetchImpl, url, init, label, timeoutMs) {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw new Error(`${label} timed out.`, { cause: error });
    throw new Error(`${label} failed before receiving a response.`, { cause: error });
  }
}

export async function openAdminSession({ adminOrigin, email, password, fetchImpl = fetch, timeoutMs = 20_000 }) {
  const response = await request(fetchImpl, `${adminOrigin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", origin: adminOrigin },
    body: JSON.stringify({ email, password, rememberMe: false }),
  }, "Admin sign-in", timeoutMs);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Admin sign-in failed with HTTP ${response.status}.`);
  }
  const cookieHeaders = extractSetCookieHeaders(response.headers);
  const cookieHeader = buildCookieHeader(cookieHeaders);
  let body;
  try {
    body = await boundedJson(response, "Admin sign-in");
    if (body?.twoFactorRedirect) throw new Error("Admin sign-in requires interactive two-factor verification.");
    if (!cookieHeader) throw new Error("Admin sign-in succeeded without a session cookie.");
  } catch (error) {
    if (cookieHeader) await closeAdminSession({ adminOrigin, cookieHeader, fetchImpl, timeoutMs });
    throw error;
  }
  return {
    cookieHeader,
    evidence: { statusCode: response.status, sessionCookieCount: cookieHeaders.length },
  };
}

export async function closeAdminSession({ adminOrigin, cookieHeader, fetchImpl = fetch, timeoutMs = 20_000 }) {
  try {
    const response = await request(fetchImpl, `${adminOrigin}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: cookieHeader,
        origin: adminOrigin,
      },
      body: "{}",
    }, "Admin sign-out", timeoutMs);
    await response.body?.cancel();
    return { status: response.status === 200 ? "closed" : "warning", statusCode: response.status };
  } catch {
    return { status: "warning", statusCode: null };
  }
}
