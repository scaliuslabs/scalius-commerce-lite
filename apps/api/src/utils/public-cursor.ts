// Signs and checks the continuation tokens of the public discovery reads
// (`@scalius/shared/public-cursor`). The key is derived from SCALIUS_SECRET
// with its own HKDF purpose, once per request (one signer per request);
// nothing is stored or cached across requests.
import { ServiceUnavailableError } from "@scalius/core/errors";
import { deriveRuntimeSecret, encodeBase64Url, readMasterSecret } from "@scalius/shared/runtime-secrets";

export const PUBLIC_CURSOR_SECRET_PURPOSE = "public-discovery-cursor";

const encoder = new TextEncoder();

export interface PublicCursorEnv {
  SCALIUS_SECRET?: unknown;
}

export interface PublicCursorSigner {
  /** `<position>.<signature>` for this scope. */
  sign(scope: string, position: string): Promise<string>;
  /** The position a token signed for this scope carries, or null for any other token. */
  verify(scope: string, token: string): Promise<string | null>;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** One request's signer: the HMAC key is derived on first use and reused for every token of the request. */
export function publicCursorSigner(env: PublicCursorEnv): PublicCursorSigner {
  let key: Promise<CryptoKey> | null = null;
  const hmacKey = () => (key ??= (async () => {
    const master = readMasterSecret(env);
    if (!master) throw new ServiceUnavailableError("Continuation links are unavailable right now.");
    return crypto.subtle.importKey(
      "raw",
      encoder.encode(await deriveRuntimeSecret(master, PUBLIC_CURSOR_SECRET_PURPOSE)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  })());
  // The scope and the position cannot run together: the scope never holds a newline.
  const signature = async (scope: string, position: string) => encodeBase64Url(new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(), encoder.encode(`${scope}\n${position}`)),
  ));
  return {
    async sign(scope, position) {
      return `${position}.${await signature(scope, position)}`;
    },
    async verify(scope, token) {
      const dot = token.lastIndexOf(".");
      if (dot <= 0) return null;
      const position = token.slice(0, dot);
      return constantTimeEqual(token.slice(dot + 1), await signature(scope, position)) ? position : null;
    },
  };
}
