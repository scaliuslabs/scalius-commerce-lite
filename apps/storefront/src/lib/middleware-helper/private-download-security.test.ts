import { describe, expect, it } from "vitest";
import { setPageCspHeader } from "./csp-handler";
import { applyTransportSecurityHeaders, isDigitalDownloadPathname, withPageCsp } from "./private-download-security";

const stream = () => new Response("file", {
  headers: {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": "attachment; filename=\"a.pdf\"",
    "Content-Security-Policy": "sandbox",
  },
});
const page = () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
const secure = (path: string, response: Response) => {
  const request = new Request(`https://shop.example.test${path}`);
  const withCsp = withPageCsp(path, response, { privateRelay: false, setPageCsp: (value) => setPageCspHeader(value) });
  return applyTransportSecurityHeaders(request, withCsp, { privateRelay: false });
};

describe("download stream security headers", () => {
  it("recognises only the cookie-bound stream paths", () => {
    expect(isDigitalDownloadPathname("/api/downloads/account/dge_1/1900000000/sig")).toBe(true);
    expect(isDigitalDownloadPathname("/api/downloads/order/ord_1/dge_1/1900000000/sig")).toBe(true);
    expect(isDigitalDownloadPathname("/api/downloads/ticket")).toBe(false);
    expect(isDigitalDownloadPathname("/account/downloads")).toBe(false);
  });

  it("keeps the stream's sandbox policy and sends no referrer", () => {
    const response = secure("/api/downloads/account/dge_1/1900000000/sig", stream());
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("gives every other page the page CSP", () => {
    const response = secure("/account/downloads", page());
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src");
    expect(csp).not.toBe("sandbox");
    expect(response.headers.get("Referrer-Policy")).not.toBe("no-referrer");
  });
});
