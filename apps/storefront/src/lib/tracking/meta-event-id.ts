export function createMetaEventId(eventName: string, stableKey?: string): string {
  if (stableKey) {
    return `${eventName}:${stableKey}`;
  }

  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return `${eventName}:${webCrypto.randomUUID()}`;
  }

  if (typeof webCrypto?.getRandomValues === "function") {
    const values = webCrypto.getRandomValues(new Uint32Array(2));
    return `${eventName}:${values[0]?.toString(36)}${values[1]?.toString(36)}`;
  }

  return `${eventName}:${Date.now()}`;
}
