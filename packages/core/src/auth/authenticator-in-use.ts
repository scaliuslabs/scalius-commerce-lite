// The authenticator app signs in only when the account's saved two-step
// method allows it (`user.two_factor_method`). Better Auth offers and accepts
// any stored, verified authenticator key, and accounts that enrolled with
// email codes before a method change marked the key unverified still hold one
// they never scanned. Deciding by the saved method, not by the key row, makes
// that data harmless without a migration:
//
//   - "totp": the authenticator is the method;
//   - "email": it is not, whatever key row is left;
//   - none saved (an enrolment made through Better Auth alone): Better Auth's
//     own rule, a verified key, still decides.
//
// The sign-in answer lists the authenticator only when it is allowed
// (`twoFactorMethodsForAccount`, apps/api/src/dashboard/auth.ts), and a
// sign-in authenticator code is refused otherwise (`onlyTheAuthenticatorInUse`,
// a Better Auth before-hook). Verification with a session (enrolling a new
// key, the admin API's method change and step-up) is the admin API's own
// business and checks the method there.
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { user } from "@scalius/database/schema";

/** The Better Auth path that signs in with an authenticator code. */
const VERIFY_TOTP_PATH = "/two-factor/verify-totp";
/** Better Auth's pending-sign-in cookie (two-factor plugin `TWO_FACTOR_COOKIE_NAME`). */
const TWO_FACTOR_COOKIE = "two_factor";

export const AUTHENTICATOR_NOT_IN_USE = "AUTHENTICATOR_NOT_IN_USE";

/** Whether the saved method lets the authenticator sign in: "totp", or none saved. */
export function authenticatorAllowed(method: string | null | undefined): boolean {
  return method === null || method === undefined || method === "totp";
}

/**
 * The second-step methods a sign-in may offer this account, from Better Auth's
 * list ("totp", "otp"): without the authenticator unless it is allowed, and
 * the saved method first. Unknown entries keep their place.
 */
export function twoFactorMethodsForAccount(methods: readonly unknown[], method: string | null | undefined): unknown[] {
  const offered = authenticatorAllowed(method) ? [...methods] : methods.filter((entry) => entry !== "totp");
  const preferred = method === "totp" ? "totp" : method === "email" ? "otp" : null;
  if (!preferred || !offered.includes(preferred)) return offered;
  return [preferred, ...offered.filter((entry) => entry !== preferred)];
}

/** Refuses a sign-in authenticator code for an account whose saved method is not the authenticator. */
export function onlyTheAuthenticatorInUse(db: Database) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path !== VERIFY_TOTP_PATH) return;
    if (await getSessionFromCtx(ctx)) return;
    const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
    const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    // No pending sign-in: Better Auth refuses the request itself.
    if (!identifier) return;
    const pending = await ctx.context.internalAdapter.findVerificationValue(identifier);
    if (!pending) return;
    const account = await db.select({ method: user.twoFactorMethod }).from(user).where(eq(user.id, pending.value)).get();
    if (!account || authenticatorAllowed(account.method)) return;
    throw new APIError("BAD_REQUEST", {
      code: AUTHENTICATOR_NOT_IN_USE,
      message: "This account signs in with emailed codes, not an authenticator app.",
    });
  });
}
