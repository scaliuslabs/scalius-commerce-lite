import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPolarWebhook } from "./polar";

const secret = "test-secret";

function sign(body: string): Record<string, string> {
  const id = "test-event";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
}

describe("verifyPolarWebhook", () => {
  it.each([
    ["empty", ""],
    ["unknown", JSON.stringify({ type: "not.real", data: { id: "event-data" } })],
  ])("rejects a correctly signed %s payload", (_name, body) => {
    expect(verifyPolarWebhook(body, sign(body), secret).verified).toBe(false);
  });
});
