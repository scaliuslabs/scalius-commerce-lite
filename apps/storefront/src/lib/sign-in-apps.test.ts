import { describe, expect, it } from "vitest";
import {
  continueWithLabel,
  readSignInApps,
  signInAppHref,
  signInErrorMessage,
  signInLanguage,
} from "./sign-in-apps";

describe("sign-in apps", () => {
  it("keeps only well-formed app providers", () => {
    expect(readSignInApps([
      { id: "acme.signin:google", name: " Google " },
      { id: "google", name: "No plugin id" },
      { id: "acme.signin:google/../x", name: "Path trick" },
      { id: "acme.signin:apple", name: "" },
      null,
      "acme.signin:apple",
    ])).toEqual([{ id: "acme.signin:google", name: "Google" }]);
    expect(readSignInApps(undefined)).toEqual([]);
  });

  it("links to the same-origin proxy with only a same-site return path", () => {
    const app = { id: "acme.signin:google", name: "Google" };
    expect(signInAppHref(app)).toBe("/api/customer-auth/identity/acme.signin:google/start");
    expect(signInAppHref(app, { returnTo: "/en-in/cart", locale: "bn" }))
      .toBe("/api/customer-auth/identity/acme.signin:google/start?returnTo=%2Fen-in%2Fcart&locale=bn");
    expect(signInAppHref(app, { returnTo: "https://evil.test", locale: "bengali" }))
      .toBe("/api/customer-auth/identity/acme.signin:google/start");
  });

  it("speaks English or Bangla by the store language", () => {
    expect(signInLanguage("bn-BD")).toBe("bn");
    expect(signInLanguage("en")).toBe("en");
    expect(signInLanguage(undefined)).toBe("en");
    expect(continueWithLabel("Google", "en")).toBe("Continue with Google");
    expect(continueWithLabel("Google", "bn")).toBe("Google দিয়ে চালিয়ে যান");
  });

  it("answers only the fixed error values", () => {
    expect(signInErrorMessage("identity", "en")).toContain("couldn't sign you in");
    expect(signInErrorMessage("needs_details", "bn")).toContain("তথ্য");
    expect(signInErrorMessage("<script>", "en")).toBeNull();
    expect(signInErrorMessage(null, "en")).toBeNull();
  });
});
