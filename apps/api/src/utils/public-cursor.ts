// Signs and checks the continuation tokens of the public discovery reads
// (`@scalius/shared/public-cursor`). The key is derived from SCALIUS_SECRET
// with its own HKDF purpose on each use; nothing is stored or cached.
import { ServiceUnavailableError } from "@scalius/core/errors";
import { deriveRuntimeSecret, encodeBase64Url, readMasterSecret } from "@scalius/shared/runtime-secrets";

export const PUBLIC_CURSOR_SECRET_PURPOSE = "public-discovery-cursor";

const encoder = new TextEncoder();

export interface PublicCursorEnv {
  SCALIUS_SECRET?: unknown;
}

async function signature(env: PublicCursorEnv, scope: string, position: string): Promise<string> {
  const master = readMasterSecret(env);
  if (!master) throw new ServiceUnavailableError("Continuation links are unavailable right now.");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(await deriveRuntimeSecret(master, PUBLIC_CURSOR_SECRET_PURPOSE)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // The scope and the position cannot run together: the scope never holds a newline.
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${scope}\n${position}`));
  return encodeBase64Url(new Uint8Array(mac));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** `<position>.<signature>` for this scope. */
export async function signPublicCursor(env: PublicCursorEnv, scope: string, position: string): Promise<string> {
  return `${position}.${await signature(env, scope, position)}`;
}

/** The position a token signed for this scope carries, or null for any other token. */
export async function verifyPublicCursor(env: PublicCursorEnv, scope: string, token: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const position = token.slice(0, dot);
  const presented = token.slice(dot + 1);
  return constantTimeEqual(presented, await signature(env, scope, position)) ? position : null;
}
