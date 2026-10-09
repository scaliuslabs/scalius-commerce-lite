// Sign-in for the dashboard quality harness (docs/ADMIN-QUALITY.md).
// The local test admin's defaults are read from scripts/dev-admin.mjs when the
// harness starts (that file runs on import, so it is read as text). The
// password is never printed and never written: only the session cookies go to
// the storage state file.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `process.env.NAME || "value"` in dev-admin.mjs: the value, or null. */
export function defaultFromSource(source, envName) {
  const match = source.match(new RegExp(`${envName}\\s*\\|\\|\\s*"([^"]*)"`));
  return match ? match[1] : null;
}

export function readAdminCredentials(root, env = process.env) {
  const source = readFileSync(join(root, "scripts/dev-admin.mjs"), "utf8");
  const email = env.LOCAL_ADMIN_EMAIL || defaultFromSource(source, "LOCAL_ADMIN_EMAIL");
  const password = env.LOCAL_ADMIN_PASSWORD || defaultFromSource(source, "LOCAL_ADMIN_PASSWORD");
  if (!email || !password) throw new Error("scripts/dev-admin.mjs has no local admin defaults to sign in with.");
  return { email, password };
}

/**
 * Signs in through the real Better Auth endpoint of the audited origin
 * (the dev server proxies /api/auth), with that origin as the Origin header,
 * and returns the Playwright storage state (cookies only).
 */
export async function signInStorageState(browser, origin, credentials) {
  const context = await browser.newContext();
  try {
    const response = await context.request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { "content-type": "application/json", origin },
      data: { email: credentials.email, password: credentials.password },
    });
    if (!response.ok()) {
      const body = await response.text().catch(() => "");
      throw new Error(`Sign-in answered ${response.status()}: ${body.replaceAll(credentials.password, "***").slice(0, 200)}`);
    }
    const payload = await response.json().catch(() => ({}));
    if (payload?.twoFactorRedirect) throw new Error("The local admin needs two-factor sign-in; run `pnpm dev:admin:reset` for a fresh admin.");
    return await context.storageState();
  } finally {
    await context.close();
  }
}
