// @vitest-environment node

import { describe, expect, it } from "vitest";

import { GET } from "../../pages/sitemap.xsl";

describe("sitemap XSL route", () => {
  it("matches the generated loc/lastmod-only sitemap XML shape", async () => {
    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Last Modified");
    expect(body).toContain("Not provided");
    expect(body).not.toContain("Priority");
    expect(body).not.toContain("Change Freq");
    expect(body).not.toContain("sitemap:priority");
    expect(body).not.toContain("sitemap:changefreq");
  });
});
