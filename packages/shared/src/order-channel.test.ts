import { describe, expect, it } from "vitest";
import {
  ORDER_CHANNELS,
  ORDER_CHANNEL_SOURCE_MAX_LENGTH,
  ORDER_CHANNEL_SOURCE_PRESETS,
  isNormalizedOrderChannelSource,
  isOrderChannel,
  isOrderChannelSourcePreset,
  normalizeOrderChannelSource,
} from "./order-channel";

describe("order channel vocabulary", () => {
  it("names the five creating surfaces and nothing else", () => {
    expect(ORDER_CHANNELS).toEqual(["online_store", "admin", "pos", "agent", "app"]);
    for (const channel of ORDER_CHANNELS) expect(isOrderChannel(channel)).toBe(true);
    for (const value of ["Online_store", "dashboard", "", null, 1]) expect(isOrderChannel(value)).toBe(false);
  });

  it("offers the Bangladesh order sources as stored, already-normalized slugs", () => {
    expect(ORDER_CHANNEL_SOURCE_PRESETS).toEqual(["facebook", "instagram", "whatsapp", "phone", "walk_in"]);
    for (const preset of ORDER_CHANNEL_SOURCE_PRESETS) {
      expect(isOrderChannelSourcePreset(preset)).toBe(true);
      expect(normalizeOrderChannelSource(preset)).toBe(preset);
      expect(isNormalizedOrderChannelSource(preset)).toBe(true);
    }
    expect(isOrderChannelSourcePreset("Facebook")).toBe(false);
    expect(isOrderChannelSourcePreset("daraz")).toBe(false);
  });

  it.each([
    ["Facebook", "facebook"],
    [" Walk-in ", "walk_in"],
    ["WhatsApp", "whatsapp"],
    ["Instagram DM", "instagram_dm"],
    ["Daraz-12", "daraz_12"],
    ["Café Bazar", "cafe_bazar"],
    ["fb__page", "fb_page"],
    ["ফেসবুক পেজ", "fesbuk_pej"],
    ["দোকানে এসে", "dokane_ese"],
    ["!!!", null],
    ["   ", null],
    ["", null],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeOrderChannelSource(input)).toBe(expected);
  });

  it("returns null for anything that is not text", () => {
    for (const value of [null, undefined, 42, {}, ["facebook"]]) {
      expect(normalizeOrderChannelSource(value)).toBeNull();
    }
  });

  it("caps the slug at 64 characters without a trailing separator", () => {
    const long = normalizeOrderChannelSource("a".repeat(80));
    expect(long).toBe("a".repeat(ORDER_CHANNEL_SOURCE_MAX_LENGTH));
    const words = normalizeOrderChannelSource("ab ".repeat(30))!;
    expect(words.length).toBeLessThanOrEqual(ORDER_CHANNEL_SOURCE_MAX_LENGTH);
    expect(words.endsWith("_")).toBe(false);
    expect(isNormalizedOrderChannelSource(words)).toBe(true);
  });

  it("is idempotent: a stored slug normalizes to itself", () => {
    for (const input of ["Facebook Page", "ফেসবুক পেজ", " Walk-in ", "x ".repeat(40), "Daraz-12", "a".repeat(80)]) {
      const once = normalizeOrderChannelSource(input);
      expect(once).not.toBeNull();
      expect(normalizeOrderChannelSource(once)).toBe(once);
      expect(isNormalizedOrderChannelSource(once)).toBe(true);
    }
  });

  it("recognizes only the stored shape as normalized", () => {
    for (const value of ["Facebook", "walk-in", "_walk", "walk_", "walk__in", "", "a".repeat(65), null]) {
      expect(isNormalizedOrderChannelSource(value)).toBe(false);
    }
  });
});
