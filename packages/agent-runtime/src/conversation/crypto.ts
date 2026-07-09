const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function conversationObjectName(
  audience: string,
  subject: string,
  conversationId: string,
): Promise<string> {
  const digest = await sha256Hex(
    `${audience}\u0000${subject}\u0000${conversationId}`,
  );
  return `${audience}:${digest}`;
}
