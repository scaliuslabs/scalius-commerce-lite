// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { RTL_PSEUDO_LOCALE } from "@scalius/shared/locale-format";
import { applyDocumentLocale, getLocale } from "~/i18n";

afterEach(() => applyDocumentLocale(getLocale()));

describe("the dashboard document's language", () => {
  it("sets the page's language and direction, right to left for the RTL pseudo-locale", () => {
    applyDocumentLocale("bn");
    expect(document.documentElement.dir).toBe("ltr");
    applyDocumentLocale(RTL_PSEUDO_LOCALE);
    expect(document.documentElement.lang).toBe(RTL_PSEUDO_LOCALE);
    expect(document.documentElement.dir).toBe("rtl");
  });
});
