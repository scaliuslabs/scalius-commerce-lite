import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errorScreenPatterns, judgeRender, runSurfaceOpen } from "./audit.mjs";

const errorTitles = errorScreenPatterns(readFileSync(new URL("../../apps/admin-v2/src/i18n/states.ts", import.meta.url), "utf8"));
const permissionTitles = errorTitles.filter((title) => title.key === "noPermissionTitle");
const permissionPath = "/admin/access-denied";
const text = (title, errorStateKind = "no-permission") => ({ text: title.text, sel: "main h1", data: false, errorStateKind });
const facts = (texts = []) => ({ texts, main: { exists: true, textLength: 100, hasMedia: false } });
const judge = (pageFacts, wantedUrl = permissionPath, finalUrl = wantedUrl, routePath = wantedUrl) => judgeRender(pageFacts, { routePath, wantedUrl, finalUrl, errorTitles });
const rules = (...args) => judge(...args).map((item) => item.rule);

it.each([true, false])("requires a visibly opened surface before checking Escape (opened: %s)", async (visible) => {
  const findings = [];
  const page = {
    locator: () => ({ first: () => ({ waitFor: async () => { if (!visible) throw new Error("menu never appeared"); } }) }),
    waitForTimeout: async () => {},
  };
  expect(await runSurfaceOpen(page, { surface: { waitFor: "[role=menu]" } }, findings, {})).toBe(visible);
  expect(findings.map(({ rule }) => rule)).toEqual(visible ? [] : ["render"]);
});

describe("route render judgment", () => {
  it("reads the permission heading separately in both catalog languages", () => {
    expect(permissionTitles).toHaveLength(2);
    expect(errorTitles.filter((title) => title.key !== "noPermissionTitle")).toHaveLength(6);
  });

  it.each(permissionTitles)("accepts the intended permission state: $text", (title) => {
    expect(judge(facts([text(title)]))).toEqual([]);
    expect(judge(facts([text(title)]), "http://localhost:4323/admin/access-denied/", "http://localhost:4323/admin/access-denied?locale=bn", permissionPath)).toEqual([]);
  });

  it.each(permissionTitles)("accepts the canonical permission route under a deployment prefix: $text", (title) => {
    const url = "http://localhost:4323/prefix/admin/access-denied";
    expect(judge(facts([text(title)]), url, url, permissionPath)).toEqual([]);
    expect(rules(facts([text(title)]), url, url, "/admin/orders")).toEqual(["render"]);
    expect(rules(facts([text(title)]), url, "http://localhost:4323/prefix/auth/login", permissionPath)).toEqual(["redirected", "render"]);
  });

  it.each([null, "error", "not-found"])("rejects a permission heading without its intended state (%s)", (kind) => {
    expect(rules(facts([text(permissionTitles[0], kind)]))).toEqual(["render"]);
  });

  it("rejects permission denials on other requested routes", () => {
    for (const title of permissionTitles) {
      expect(rules(facts([text(title)]), "/admin/orders")).toEqual(["render"]);
      expect(rules(facts([text(title)]), "/admin/access-denied/details")).toEqual(["render"]);
    }
  });

  it("keeps redirects into and out of the permission route visible", () => {
    expect(rules(facts([text(permissionTitles[0])]), "/admin/orders", permissionPath)).toEqual(["redirected", "render"]);
    expect(rules(facts(), permissionPath, "/auth/login")).toEqual(["redirected"]);
    expect(rules(facts([text(permissionTitles[0])]), permissionPath, "/auth/login")).toEqual(["redirected", "render"]);
  });

  it("rejects generic, update and not-found headings even inside a permission state", () => {
    for (const title of errorTitles.filter((item) => item.key !== "noPermissionTitle")) {
      const result = judge(facts([text(permissionTitles[0]), text(title)]));
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ rule: "render", impact: "critical" });
      expect(result[0].message).toContain(title.text);
    }
  });

  it("does not let the intended permission heading conceal an unrelated permission error", () => {
    expect(rules(facts([text(permissionTitles[0]), text(permissionTitles[1], null)]))).toEqual(["render"]);
  });

  it("keeps blank or missing main content failures on the permission route", () => {
    for (const main of [
      { exists: false, textLength: 0, hasMedia: false },
      { exists: true, textLength: 0, hasMedia: false },
    ]) {
      expect(rules({ ...facts(), main })).toEqual(["blank-page"]);
      expect(rules({ ...facts([text(permissionTitles[0])]), main })).toEqual(["blank-page"]);
    }
  });

  it("keeps ordinary content and merchant data with a matching title valid", () => {
    expect(judge(facts(), "/admin/orders")).toEqual([]);
    expect(judge(facts([{ ...text(errorTitles[0]), data: true }]), "/admin/products")).toEqual([]);
  });
});
