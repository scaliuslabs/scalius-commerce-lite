import { describe, expect, it } from "vitest";
import { mediaMessages } from "./media";
import { mediaPickerMessages } from "./media-picker";
import { inboxMessages } from "./inbox";
import { orderConversationMessages } from "./order-conversation";
import { productMerchandisingMessages } from "./product-merchandising";
import { productContentSummaryMessages } from "./product-content-summary";

describe("copy shared across lazy editor boundaries", () => {
  it.each(["en", "bn"] as const)("retains identical %s labels and interpolation variables", (locale) => {
    for (const key of ["removeImage", "changeImage", "noImage"] as const) {
      expect(mediaMessages[locale][key]).toBe(mediaPickerMessages[locale][key]);
    }
    for (const key of Object.keys(orderConversationMessages.en) as Array<keyof typeof orderConversationMessages.en>) {
      expect(inboxMessages[locale][key]).toBe(orderConversationMessages[locale][key]);
    }
    for (const key of Object.keys(productContentSummaryMessages.en) as Array<keyof typeof productContentSummaryMessages.en>) {
      expect(productMerchandisingMessages[locale][key]).toBe(productContentSummaryMessages[locale][key]);
    }
    expect(mediaPickerMessages[locale].removeImage).toContain("{name}");
    expect(productContentSummaryMessages[locale].blockCount).toContain("count");
  });
});
