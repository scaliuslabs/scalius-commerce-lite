// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { playVideoFacade } from "./video-facade";

describe("video facade embed autoplay", () => {
  it.each([
    ["https://www.youtube-nocookie.com/embed/video?start=12", "0"],
    ["https://youtube-nocookie.com/embed/video", "0"],
    ["https://WWW.YOUTUBE-NOCOOKIE.COM/embed/video", "0"],
    ["https://player.vimeo.com/video/123?h=private", null],
    ["https://notyoutube-nocookie.com/embed/video", null],
    ["https://youtube-nocookie.com.attacker.test/embed/video", null],
    ["https://youtube-nocookie.com@attacker.test/embed/video", null],
  ])("classifies the parsed hostname of %s", (src, rel) => {
    const box = document.createElement("div");
    const facade = document.createElement("a");
    facade.dataset.videoKind = "embed";
    facade.dataset.videoSrc = src;
    box.append(facade);

    const player = playVideoFacade(facade) as HTMLIFrameElement;
    const actual = new URL(player.src);
    const original = new URL(src);
    expect(actual.hostname).toBe(original.hostname);
    expect(actual.searchParams.get("autoplay")).toBe("1");
    expect(actual.searchParams.get("rel")).toBe(rel);
    for (const [key, value] of original.searchParams) {
      expect(actual.searchParams.get(key)).toBe(value);
    }
    expect(facade.hidden).toBe(true);
  });
});
