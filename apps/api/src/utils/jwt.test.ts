import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateToken,
  verifyToken,
} from "./jwt";

describe("JWT secret source", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("signs only with the JWT_SECRET carried by the composed runtime env", () => {
    vi.stubEnv("JWT_SECRET", "process-env-secret-must-never-be-used-here");

    expect(() => generateToken({ id: "system" }, "1h", {})).toThrow(
      "Failed to generate authentication token",
    );
    expect(() => generateToken({ id: "system" }, "1h", { JWT_SECRET: "" })).toThrow(
      "Failed to generate authentication token",
    );
    expect(
      generateToken({ id: "system" }, "1h", {
        JWT_SECRET: "runtime-env-secret-with-at-least-thirty-two-chars",
      }),
    ).toEqual(expect.any(String));
  });

  it("rejects verification when the composed env has no JWT_SECRET", async () => {
    vi.stubEnv("JWT_SECRET", "process-env-secret-must-never-be-used-here");
    const secret = "runtime-env-secret-with-at-least-thirty-two-chars";
    const token = generateToken({ id: "system" }, "1h", { JWT_SECRET: secret });
    await expect(verifyToken(token, {})).rejects.toThrow(
      "JWT_SECRET is not available in the runtime env",
    );
    await expect(verifyToken(token, { JWT_SECRET: secret })).resolves.toMatchObject({
      id: "system",
    });
  });
});
