import { afterEach, describe, expect, it } from "vitest";
import { defineMessages, setLocale, translate } from "./index";

const messages = defineMessages({
  en: { saved: "Order saved", items: "{count} items" },
  bn: { saved: "অর্ডার সেভ হয়েছে", items: "{count}টি পণ্য" },
});

afterEach(() => setLocale("en"));

describe("dashboard messages", () => {
  it("translates the active locale and formats numeric variables for it", () => {
    expect(translate(messages, "items", { count: 1200 })).toBe("1,200 items");
    setLocale("bn");
    expect(translate(messages, "saved")).toBe("অর্ডার সেভ হয়েছে");
    expect(translate(messages, "items", { count: 12 })).toBe("১২টি পণ্য");
  });
});
