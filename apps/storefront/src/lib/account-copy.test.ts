// @vitest-environment node
// The customer account's catalogues (its own words, downloads, gift cards,
// conversations, a shared cart): every key in both languages, none empty, and
// no English word in Bangla.
import { describe, expect, it } from "vitest";
import { accountCopy } from "./account-copy";
import { downloadCopy } from "./account-downloads";
import { giftCardPageCopy } from "./account-gift-cards";
import { conversationCopy } from "./account-inbox";
import { cartShareCopy } from "./conversation-cart-share";

/** Every leaf with its words; functions answer sample Bangla values. */
function leaves(value: unknown, path = ""): Array<[string, string]> {
  if (typeof value === "function") return [[path, String((value as (...args: string[]) => unknown)("৳১", "২", "৩"))]];
  if (typeof value === "string") return [[path, value]];
  return Object.entries(value as object).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key));
}

const CATALOGUES = {
  account: accountCopy,
  downloads: downloadCopy,
  giftCards: giftCardPageCopy,
  conversations: conversationCopy,
  cartShare: cartShareCopy,
} as const;

describe("the account's words", () => {
  it.each(Object.entries(CATALOGUES))("%s: every key in both languages, none empty, no English in Bangla", (_name, catalogue) => {
    const en = leaves(catalogue("en"));
    const bn = leaves(catalogue("bn"));
    expect(bn.map(([path]) => path)).toEqual(en.map(([path]) => path));
    expect([...en, ...bn].filter(([, text]) => !text.trim())).toEqual([]);
    // Placeholders ({count}) and the file-size unit "B" aside, Bangla has no Latin word.
    expect(bn.filter(([, text]) => /[A-Za-z]{2,}/.test(text.replace(/\{\w+\}/g, "")))).toEqual([]);
    // The same placeholders in both languages, so a filled template never leaves a brace behind.
    const holes = (entries: Array<[string, string]>) => entries.map(([path, text]) => `${path}:${[...text.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort().join("")}`);
    expect(holes(bn)).toEqual(holes(en));
  });

  it("follows the page's language: Bangla for bn-BD, English otherwise", () => {
    expect(accountCopy("bn-BD").shell.signOut).toBe("সাইন আউট");
    expect(accountCopy("fr").shell.signOut).toBe("Sign out");
    expect(conversationCopy("bn").send).toBe("পাঠান");
  });

  it("asks for a note on the reason both reason lists end with", () => {
    for (const language of ["en", "bn"]) {
      const words = accountCopy(language).order;
      expect(words.cancelReasons.at(-1)).toBe(words.other);
      expect(words.returnReasons.at(-1)).toBe(words.other);
    }
  });
});
