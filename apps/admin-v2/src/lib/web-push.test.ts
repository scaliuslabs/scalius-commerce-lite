import { describe, expect, it } from "vitest";
import { applicationServerKey, browserAndSystem } from "./web-push";

describe("device label", () => {
  it("names the browser and the system, nothing finer", () => {
    expect(browserAndSystem("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"))
      .toEqual({ browser: "Chrome", system: "macOS" });
    expect(browserAndSystem("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"))
      .toEqual({ browser: "Edge", system: "Windows" });
    expect(browserAndSystem("Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0"))
      .toEqual({ browser: "Firefox", system: "Android" });
    expect(browserAndSystem("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"))
      .toEqual({ browser: "Safari", system: "iOS" });
    expect(browserAndSystem("curl/8.0")).toEqual({ browser: "", system: "" });
  });
});

describe("application server key", () => {
  it("decodes the URL-safe base64 public key to its 65 bytes", () => {
    const key = applicationServerKey("BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U");
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(65);
    // An uncompressed P-256 point starts with 0x04.
    expect(key[0]).toBe(4);
  });
});
