// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VideoEmbed } from "./video-embed";

describe("VideoEmbed", () => {
  let editor: Editor | null = null;

  beforeEach(() => {
    const testWindow = document.defaultView as Window & {
      happyDOM?: { settings: { disableIframePageLoading: boolean } };
    };
    if (testWindow.happyDOM) {
      testWindow.happyDOM.settings.disableIframePageLoading = true;
    }
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("serializes a responsive privacy-enhanced YouTube embed", () => {
    editor = new Editor({ extensions: [StarterKit, VideoEmbed] });

    expect(
      editor.commands.setVideoEmbed({
        src: "https://youtu.be/dQw4w9WgXcQ",
      }),
    ).toBe(true);

    const html = editor.getHTML();
    expect(html).toContain('class="rich-video-embed"');
    expect(html).toContain('data-video-provider="youtube"');
    expect(html).toContain(
      'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"',
    );
    expect(html).toContain('loading="lazy"');
  });

  it("round-trips Vimeo embeds and rejects arbitrary iframe hosts", () => {
    editor = new Editor({ extensions: [StarterKit, VideoEmbed] });
    expect(
      editor.commands.setVideoEmbed({ src: "https://vimeo.com/76979871" }),
    ).toBe(true);
    expect(editor.getJSON().content?.[0]?.attrs).toMatchObject({
      provider: "vimeo",
      src: "https://player.vimeo.com/video/76979871",
    });

    expect(
      editor.commands.setVideoEmbed({ src: "https://example.com/embed/123" }),
    ).toBe(false);
  });
});
