import { describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "../../utils/credential-encryption";
import { getCapiSettings } from "./meta.service";

const baseSettings = {
  id: "singleton",
  pixelId: "1234567890",
  accessToken: "legacy-token",
  testEventCode: null,
  isEnabled: true,
  logRetentionDays: 30,
  createdAt: 1,
  updatedAt: 1,
};

function createDb(row: typeof baseSettings | null) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(async () => row),
        })),
      })),
    })),
  };
}

describe("getCapiSettings", () => {
  it("keeps legacy plaintext access tokens readable", async () => {
    const settings = await getCapiSettings(createDb(baseSettings) as never);

    expect(settings?.accessToken).toBe("legacy-token");
  });

  it("fails closed when an encrypted access token cannot be decrypted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const key = Buffer.alloc(32, 7).toString("base64");
    const wrongKey = Buffer.alloc(32, 8).toString("base64");
    const encryptedToken = await encryptCredentials("live-meta-token", key);

    try {
      const settings = await getCapiSettings(
        createDb({ ...baseSettings, accessToken: encryptedToken }) as never,
        wrongKey,
      );

      expect(settings?.accessToken).toBeNull();
      expect(JSON.stringify(settings)).not.toContain(encryptedToken);
      expect(warnSpy).toHaveBeenCalledWith(
        "[Meta CAPI] Access token is not ready:",
        "Meta Conversions API access token could not be decrypted with the configured credential key.",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
