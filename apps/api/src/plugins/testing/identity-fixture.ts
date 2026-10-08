// A buyer sign-in app written without the SDK, run by the bundled loader in
// the identity route tests: `authorize` builds the provider's sign-in URL and
// remembers the PKCE challenge it was given (by nonce); `exchange` checks the
// verifier against it, as a real provider does, and turns the code into
// verified facts (the code picks the person). It fails in the ways the port
// defines.

import { PLUGIN_API_VERSION } from "@scalius/shared/plugins/api-version";

export const IDENTITY_FIXTURE_ID = "acme.signin";
export const IDENTITY_FIXTURE_PROVIDER = `${IDENTITY_FIXTURE_ID}:google`;
export const IDENTITY_FIXTURE_SECRET = "identity-fixture-secret-0123456789";

export const IDENTITY_FIXTURE_MANIFEST = {
  id: IDENTITY_FIXTURE_ID,
  name: "Acme Sign-in",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "A buyer sign-in provider fixture.",
  author: { name: "Acme" },
  settings: [{ key: "client_secret", label: "Client secret", type: "secret", required: true }],
  storage: { challenges: { indexes: [], unique: [] } },
  providers: {
    identity: [{ id: "google", name: "Google" }],
  },
} as const;

/** The module source (ES module, no imports). */
export const IDENTITY_FIXTURE_CODE = `
const manifest = ${JSON.stringify(IDENTITY_FIXTURE_MANIFEST)};
function providerError(category, message, options = {}) {
  const error = new Error(message);
  error.name = "ProviderError";
  error.category = category;
  error.uncertain = options.uncertain === true;
  error.code = options.code;
  return error;
}
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
}
const PEOPLE = {
  "new-user": { subject: "sub-new", email: "new@example.test", emailVerified: true, phone: "+8801733333333", phoneVerified: true, name: "New Buyer" },
  "unverified": { subject: "sub-unverified", email: "owner@example.test", emailVerified: false, name: "Pretender" },
  "known-email": { subject: "sub-known", email: "owner@example.test", emailVerified: true, name: "Owner" },
};
export default {
  manifest,
  providers: {
    google: {
      kind: "identity",
      async authorize(input, ctx) {
        await ctx.storage.challenges.put(input.nonce, { challenge: input.codeChallenge });
        const query = new URLSearchParams({
          state: input.state,
          nonce: input.nonce,
          code_challenge: input.codeChallenge,
          code_challenge_method: "S256",
          redirect_uri: input.redirectUri,
          hl: input.locale,
        });
        return { url: "https://accounts.acme.test/authorize?" + query.toString() };
      },
      async exchange(input, ctx) {
        if (input.code === "refused") throw providerError("declined", "The code was refused.", { code: "acme.refused" });
        const seen = await ctx.storage.challenges.get(input.nonce);
        if (!seen) throw providerError("declined", "Unknown sign-in.", { code: "acme.unknown" });
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.codeVerifier));
        if (base64Url(new Uint8Array(digest)) !== seen.challenge) throw providerError("declined", "The PKCE verifier does not match.", { code: "acme.pkce" });
        const person = PEOPLE[input.code];
        if (!person) throw providerError("declined", "Unknown code.", { code: "acme.code" });
        return person;
      },
    },
  },
};
`;
