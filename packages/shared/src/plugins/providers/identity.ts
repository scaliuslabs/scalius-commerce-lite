// The identity port: buyer sign-in with another account ("Sign in with
// Google", a regional ID service), OAuth 2.0 authorization code with PKCE.
//
// The platform owns the flow and its security: it makes the `state`, the
// `nonce` and the PKCE verifier, keeps them in a signed, short-lived,
// httpOnly cookie, checks `state` on return and creates the customer session
// itself. The app owns only the provider: it builds the authorization URL
// from its settings (`authorize`) and turns the returned code into verified
// facts about the person (`exchange`: it checks the ID token's signature,
// audience and nonce). A verified email or phone links to an existing
// customer; an unverified one never does.
//
// Staff sign-in is not on this port: the dashboard's single sign-on is the
// operator's identity handoff (Platform settings, `identityHandoff`), whose
// signed token also carries the staff role. An app never decides who is
// staff.

import { z } from "zod";

const httpsUrl = z.string().max(2048).regex(/^https:\/\/[^\s]+$/, "Use an https URL.");

export const identityAuthorizeInputSchema = z.object({
  /** Opaque; the provider sends it back unchanged. */
  state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  /** Put in the ID token request; `exchange` checks it. */
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  /** PKCE S256 challenge (RFC 7636). */
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** The platform's callback URL; register it with the provider. */
  redirectUri: httpsUrl,
  /** The page's language (ISO 639-1). */
  locale: z.string().regex(/^[a-z]{2}$/),
}).strict();

export const identityAuthorizeOutputSchema = z.object({
  /** The provider's sign-in page (https). */
  url: httpsUrl,
}).strict();

export const identityExchangeInputSchema = z.object({
  code: z.string().min(1).max(4096),
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  redirectUri: httpsUrl,
}).strict();

export const identityExchangeOutputSchema = z.object({
  /** The provider's stable id for the person (`sub`). */
  subject: z.string().min(1).max(255),
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  /** True only when the provider verified the address. */
  emailVerified: z.boolean().default(false),
  /** E.164. */
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
  phoneVerified: z.boolean().default(false),
  name: z.string().trim().max(200).optional(),
}).strict();

export const IDENTITY_PORT = {
  authorize: { input: identityAuthorizeInputSchema, output: identityAuthorizeOutputSchema },
  exchange: { input: identityExchangeInputSchema, output: identityExchangeOutputSchema },
} as const;

export type IdentityAuthorizeInput = z.infer<typeof identityAuthorizeInputSchema>;
export type IdentityExchangeInput = z.infer<typeof identityExchangeInputSchema>;
export type IdentityExchangeOutput = z.infer<typeof identityExchangeOutputSchema>;
