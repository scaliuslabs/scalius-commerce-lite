// "Continue with <app>": buyer sign-in through an app's identity provider
// (OAuth 2.0 authorization code with PKCE; packages/plugin-sdk/docs/apps.md,
// "Identity"). Both routes are browser navigations, safe without JavaScript.
//
// The platform owns the flow: it makes the state, nonce and PKCE verifier,
// keeps them in one signed httpOnly cookie (identity-state.ts), checks `state`
// on return and creates the session itself. The app only builds the provider's
// sign-in URL (`authorize`) and turns the returned code into verified facts
// (`exchange`). The redirect URI is the storefront's own callback
// (`<store>/api/customer-auth/identity/<provider>/callback`): the storefront
// proxies customer-auth calls, so the state cookie and the session cookies
// belong to the origin the buyer browses, as for a code sign-in.
//
// Every failure ends on the storefront account page with a fixed
// `sign_in_error` value. The URL never carries provider messages, codes,
// emails or tokens; logs carry the provider id and a failure code only.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  SESSION_TTL_SECONDS,
  buildSetCookieHeader,
  getCookieConfig,
  signInWithIdentity,
} from "@scalius/core/modules/customers";
import { resolveAppProvider } from "@scalius/core/integrations/provider-port";
import { isQualifiedProviderId, providerErrorOf } from "@scalius/shared/plugins/providers";
import { ServiceUnavailableError } from "../../utils/api-error";
import { getCustomerSessionHashKey } from "../../utils/encryption-key";
import { getTrustedClientIp } from "../../utils/client-ip";
import { isWithinRateLimit } from "../../utils/rate-limit";
import { requestAppProviders } from "../../plugins/providers/app-providers";
import {
  IDENTITY_STATE_TTL_SECONDS,
  clearIdentityStateCookie,
  constantTimeEqual,
  identityStateCookie,
  openIdentityState,
  pkceChallenge,
  randomToken,
  readIdentityStateCookie,
  safeReturnTo,
  sealIdentityState,
} from "./identity-state";

const app = new OpenAPIHono<{ Bindings: Env }>();

type IdentityContext = Context<{ Bindings: Env }>;

const PROVIDER_CALL_TIMEOUT_MS = 10_000;
const providerParam = z.object({
  providerId: z.string().min(1).max(150).openapi({ param: { name: "providerId", in: "path" }, description: "The app's identity provider id (`<plugin id>:<provider id>`)." }),
});

/** The storefront origin buyers return to; sign-in cannot run without one. */
function storefrontBase(c: IdentityContext): URL {
  try {
    return new URL(c.env.STOREFRONT_URL ?? "");
  } catch {
    throw new ServiceUnavailableError("Sign-in is not available: the store address is not set.");
  }
}

/** The callback the provider returns to, on the storefront origin; null unless https. */
function callbackUrl(base: URL, providerId: string): string | null {
  if (base.protocol !== "https:") return null;
  // The id's characters (letters, digits, `.`, `-`, `:`) are all valid in a path segment as they are.
  return new URL(`/api/customer-auth/identity/${providerId}/callback`, base).toString();
}

function noStore(c: IdentityContext) {
  c.header("Cache-Control", "private, no-store");
}

/** Ends the flow on the account page with a fixed error; the cookie is cleared. */
function failure(c: IdentityContext, base: URL, error: "identity" | "needs_details", code: string, providerId: string | null) {
  console.warn("[CustomerAuth] Identity sign-in did not complete", { provider: providerId, code });
  noStore(c);
  c.header("Set-Cookie", clearIdentityStateCookie(), { append: true });
  const target = new URL("/account", base);
  target.searchParams.set("sign_in_error", error);
  return c.redirect(target.toString(), 302);
}

const redirectResponses = {
  302: { description: "Redirect: the provider's sign-in page, or back to the store" },
} as const;

// ─── GET /identity/{providerId}/start ───────────────────────────────────────

app.openapi(createRoute({
  method: "get",
  path: "/identity/{providerId}/start",
  operationId: "storefront.customer_auth_identity.start",
  tags: ["Customer Auth"],
  summary: "Start Continue with an app (browser redirect to the provider)",
  request: {
    params: providerParam,
    query: z.object({
      returnTo: z.string().max(2048).optional().openapi({ description: "A storefront path to return to after signing in. Default /account." }),
      locale: z.string().max(16).optional().openapi({ description: "The page's language (ISO 639-1) for the provider's page." }),
    }),
  },
  responses: redirectResponses,
}), async (c) => {
  const base = storefrontBase(c);
  const { providerId } = c.req.valid("param");
  const { returnTo, locale } = c.req.valid("query");
  if (!isQualifiedProviderId(providerId)) return failure(c, base, "identity", "provider_id", null);

  if (!await isWithinRateLimit(c.env, "RL_STANDARD", "customer-identity-start", getTrustedClientIp(c))) {
    return failure(c, base, "identity", "rate_limited", providerId);
  }
  const redirectUri = callbackUrl(base, providerId);
  if (!redirectUri) return failure(c, base, "identity", "redirect_not_https", providerId);

  const { provider, issue } = await resolveAppProvider(requestAppProviders(c), "identity", providerId);
  if (!provider) return failure(c, base, "identity", issue ? "provider_not_ready" : "provider_unavailable", providerId);

  const codeVerifier = randomToken();
  const flow = {
    providerId,
    state: randomToken(),
    nonce: randomToken(),
    codeVerifier,
    returnTo: safeReturnTo(returnTo),
    expiresAt: Math.floor(Date.now() / 1000) + IDENTITY_STATE_TTL_SECONDS,
  };
  const sealed = await sealIdentityState(c.env, flow);
  if (!sealed) return failure(c, base, "identity", "no_master_secret", providerId);

  let authorizeUrl: string;
  try {
    const answer = await provider.authorize({
      state: flow.state,
      nonce: flow.nonce,
      codeChallenge: await pkceChallenge(codeVerifier),
      redirectUri,
      locale: locale && /^[a-z]{2}$/.test(locale) ? locale : "en",
    }, { signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS) });
    if (new URL(answer.url).protocol !== "https:") throw new Error("not https");
    authorizeUrl = answer.url;
  } catch (error) {
    return failure(c, base, "identity", providerErrorOf(error)?.code ?? "authorize_failed", providerId);
  }

  noStore(c);
  c.header("Set-Cookie", identityStateCookie(sealed), { append: true });
  return c.redirect(authorizeUrl, 302);
});

// ─── GET /identity/{providerId}/callback ────────────────────────────────────

app.openapi(createRoute({
  method: "get",
  path: "/identity/{providerId}/callback",
  operationId: "storefront.customer_auth_identity.callback",
  tags: ["Customer Auth"],
  summary: "Finish Continue with an app (the provider returns here; signs the buyer in)",
  request: {
    params: providerParam,
    query: z.object({
      code: z.string().max(4096).optional(),
      state: z.string().max(256).optional(),
      error: z.string().max(256).optional().openapi({ description: "Set by the provider when the buyer declined or it failed." }),
    }),
  },
  responses: redirectResponses,
}), async (c) => {
  const base = storefrontBase(c);
  const { providerId } = c.req.valid("param");
  const { code, state, error: providerError } = c.req.valid("query");

  try {
    const flow = await openIdentityState(c.env, readIdentityStateCookie(c.req.header("Cookie")));
    if (!flow) return failure(c, base, "identity", "state_cookie", providerId);
    if (flow.providerId !== providerId) return failure(c, base, "identity", "provider_mismatch", providerId);
    if (providerError) return failure(c, base, "identity", "provider_declined", providerId);
    if (!state || !constantTimeEqual(state, flow.state)) return failure(c, base, "identity", "state_mismatch", providerId);
    if (!code) return failure(c, base, "identity", "no_code", providerId);

    if (!await isWithinRateLimit(c.env, "RL_STANDARD", "customer-identity-callback", getTrustedClientIp(c))) {
      return failure(c, base, "identity", "rate_limited", providerId);
    }
    const redirectUri = callbackUrl(base, providerId);
    if (!redirectUri) return failure(c, base, "identity", "redirect_not_https", providerId);
    const { provider } = await resolveAppProvider(requestAppProviders(c), "identity", providerId);
    if (!provider) return failure(c, base, "identity", "provider_not_ready", providerId);

    let facts: Awaited<ReturnType<typeof provider.exchange>>;
    try {
      facts = await provider.exchange(
        { code, codeVerifier: flow.codeVerifier, nonce: flow.nonce, redirectUri },
        { signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS) },
      );
    } catch (error) {
      return failure(c, base, "identity", providerErrorOf(error)?.code ?? "exchange_failed", providerId);
    }

    const result = await signInWithIdentity(c.get("db"), {
      providerId,
      facts,
      sessionHashKey: getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>),
    });
    if (result.status === "needs_account_details") return failure(c, base, "needs_details", "needs_account_details", providerId);

    const { sameSite, domainAttr } = getCookieConfig(
      c.env.STOREFRONT_URL as string | undefined,
      c.env.CUSTOMER_AUTH_COOKIE_DOMAIN as string | undefined,
    );
    noStore(c);
    c.header("Set-Cookie", buildSetCookieHeader(result.session.token, SESSION_TTL_SECONDS, domainAttr, sameSite), { append: true });
    c.header("Set-Cookie", `cs_auth=1; Max-Age=${SESSION_TTL_SECONDS}; Path=/${domainAttr}; SameSite=${sameSite}; Secure`, { append: true });
    c.header("Set-Cookie", clearIdentityStateCookie(), { append: true });
    return c.redirect(new URL(flow.returnTo, base).toString(), 302);
  } catch (error) {
    // A closed account, a failed write: the buyer sees the same fixed error.
    return failure(c, base, "identity", error instanceof Error ? error.name : "unexpected", providerId);
  }
});

export { app as customerIdentityRoutes };
