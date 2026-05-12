import { describe, expect, it } from "vitest";
import { DEFAULT_AI_PROMPTS } from "./default-prompts";

describe("default AI prompts", () => {
  it("gives homepage generation a destination-specific merchandising brief", () => {
    const prompt = DEFAULT_AI_PROMPTS.widget;

    expect(prompt).toContain("homepage widget designer");
    expect(prompt).toContain("featured collections");
    expect(prompt).toContain("homepage rhythm");
    expect(prompt).toContain("Avoid huge blank gaps");
    expect(prompt).toContain("real shoppers");
  });

  it("gives landing-page generation a campaign funnel brief", () => {
    const prompt = DEFAULT_AI_PROMPTS["landing-page"];

    expect(prompt).toContain("continuous campaign page");
    expect(prompt).toContain("funnel structure");
    expect(prompt).toContain("hero/offer");
    expect(prompt).toContain("final CTA");
    expect(prompt).toContain("Do not invent claims");
  });

  it("gives collection generation a practical merchandising brief", () => {
    const prompt = DEFAULT_AI_PROMPTS.collection;

    expect(prompt).toContain("collection page designer");
    expect(prompt).toContain("product comparison");
    expect(prompt).toContain("prices, discounts, availability cues");
    expect(prompt).toContain("merchandising flow");
    expect(prompt).toContain("Keep vertical rhythm tight");
  });
});
