import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const APP_SOURCE = fileURLToPath(new URL("./app.ts", import.meta.url));

describe("public storefront order route boundary", () => {
  it("does not put bearer auth in front of proof-based order routes", () => {
    const source = readFileSync(APP_SOURCE, "utf8");

    expect(source).toContain('app.use("/orders/*", cookieOriginGuardMiddleware)');
    expect(source).toContain('app.route("/orders", orderRoutes)');
    expect(source).not.toContain('app.use("/orders/*", authMiddleware)');
  });
});
