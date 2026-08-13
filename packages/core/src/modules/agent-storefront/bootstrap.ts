const CONTINUATION_ID_PATTERN = /^acn_[A-Za-z0-9_-]{20}$/;
const BOOTSTRAP_CODE_PATTERN = /^acb_([A-Za-z0-9_-]{20})_([A-Za-z0-9_-]{43})$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createAgentStorefrontBootstrap(
  continuationId: string,
  secret: string,
): Promise<{ code: string; codeHash: string }> {
  if (!CONTINUATION_ID_PATTERN.test(continuationId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error("Agent storefront bootstrap identity is invalid.");
  }
  const code = `acb_${continuationId.slice(4)}_${secret}`;
  return { code, codeHash: await sha256Hex(code) };
}

export function getAgentStorefrontBootstrapContinuationId(code: string): string | null {
  const match = BOOTSTRAP_CODE_PATTERN.exec(code);
  return match?.[1] ? `acn_${match[1]}` : null;
}

export async function hashAgentStorefrontBootstrapCode(code: string): Promise<string> {
  return sha256Hex(code);
}
