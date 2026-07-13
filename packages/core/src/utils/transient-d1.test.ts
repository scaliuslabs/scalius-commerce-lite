import { describe, expect, it, vi } from "vitest";
import { isTransientD1Error, retryTransientD1 } from "./transient-d1";

describe("transient D1 recovery", () => {
  it("recognizes Cloudflare internal errors that carry an incident reference", () => {
    expect(
      isTransientD1Error(
        new Error("D1_ERROR: internal error; reference = s4msp5hr8gru445bqon1v55g"),
      ),
    ).toBe(true);
    expect(isTransientD1Error(new Error("D1_ERROR: UNIQUE constraint failed"))).toBe(false);
  });

  it("retries a referenced internal read failure without retrying permanent failures", async () => {
    const recoveredRead = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("D1_ERROR: internal error; reference = incident_1"))
      .mockResolvedValueOnce("recovered");

    await expect(
      retryTransientD1(recoveredRead, { delaysMs: [0] }),
    ).resolves.toBe("recovered");
    expect(recoveredRead).toHaveBeenCalledTimes(2);

    const permanentFailure = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("D1_ERROR: malformed JSON"));
    await expect(
      retryTransientD1(permanentFailure, { delaysMs: [0] }),
    ).rejects.toThrow("malformed JSON");
    expect(permanentFailure).toHaveBeenCalledTimes(1);
  });
});
