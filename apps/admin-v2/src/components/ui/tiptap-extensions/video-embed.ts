import { Node, mergeAttributes } from "@tiptap/core";
import {
  normalizeVideoEmbed,
  type VideoEmbedProvider,
} from "@scalius/shared/video-embed";

export interface VideoEmbedAttributes {
  src: string;
  provider?: VideoEmbedProvider;
  title?: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    videoEmbed: {
      setVideoEmbed: (attributes: VideoEmbedAttributes) => ReturnType;
    };
  }
}

function readEmbedAttributes(element: HTMLElement): VideoEmbedAttributes | false {
  const iframe = element.matches("iframe")
    ? element
    : element.querySelector("iframe");
  const normalized = normalizeVideoEmbed(iframe?.getAttribute("src"));
  if (!normalized) return false;
  return {
    src: normalized.src,
    provider: normalized.provider,
    title: iframe?.getAttribute("title") || undefined,
  };
}

export const VideoEmbed = Node.create({
  name: "videoEmbed",
  group: "block",
  atom: true,
  draggable: true,
  isolating: true,

  addAttributes() {
    return {
      src: { default: null },
      provider: { default: null },
      title: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div.rich-video-embed",
        getAttrs: (element) => readEmbedAttributes(element as HTMLElement),
      },
      {
        tag: "div[data-youtube-video]",
        getAttrs: (element) => readEmbedAttributes(element as HTMLElement),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const normalized = normalizeVideoEmbed(HTMLAttributes.src);
    if (!normalized) return ["div", { class: "rich-video-embed" }];
    const title =
      typeof HTMLAttributes.title === "string" && HTMLAttributes.title.trim()
        ? HTMLAttributes.title.trim()
        : `${normalized.provider === "youtube" ? "YouTube" : "Vimeo"} video`;

    return [
      "div",
      mergeAttributes({
        class: "rich-video-embed",
        "data-video-provider": normalized.provider,
      }),
      [
        "iframe",
        {
          src: normalized.src,
          title,
          loading: "lazy",
          allow:
            "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen",
          allowfullscreen: "",
          referrerpolicy: "strict-origin-when-cross-origin",
        },
      ],
    ];
  },

  addCommands() {
    return {
      setVideoEmbed:
        (attributes: VideoEmbedAttributes) =>
        ({ commands }) => {
          const normalized = normalizeVideoEmbed(attributes.src);
          if (!normalized) return false;
          return commands.insertContent({
            type: this.name,
            attrs: {
              ...attributes,
              src: normalized.src,
              provider: normalized.provider,
            },
          });
        },
    };
  },
});
