export type VideoEmbedProvider = "youtube" | "vimeo";

export interface NormalizedVideoEmbed {
  provider: VideoEmbedProvider;
  src: string;
}

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID_RE = /^\d{1,12}$/;

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function getYouTubeId(url: URL): string | null {
  const hostname = normalizeHostname(url.hostname);
  if (hostname === "youtu.be") {
    return url.pathname.split("/").filter(Boolean)[0] ?? null;
  }
  if (
    hostname !== "youtube.com" &&
    hostname !== "m.youtube.com" &&
    hostname !== "youtube-nocookie.com"
  ) {
    return null;
  }

  if (url.pathname === "/watch") return url.searchParams.get("v");
  const [kind, id] = url.pathname.split("/").filter(Boolean);
  return kind === "embed" || kind === "shorts" || kind === "live"
    ? id ?? null
    : null;
}

function getVimeoId(url: URL): string | null {
  const hostname = normalizeHostname(url.hostname);
  const parts = url.pathname.split("/").filter(Boolean);
  if (hostname === "vimeo.com") return parts[0] ?? null;
  if (hostname === "player.vimeo.com" && parts[0] === "video") {
    return parts[1] ?? null;
  }
  return null;
}

function getVimeoHash(url: URL): string | null {
  const hostname = normalizeHostname(url.hostname);
  const parts = url.pathname.split("/").filter(Boolean);
  if (hostname === "vimeo.com") return parts[1] ?? null;
  return url.searchParams.get("h");
}

export function normalizeVideoEmbed(
  value: string | null | undefined,
): NormalizedVideoEmbed | null {
  const input = value?.trim();
  if (!input) return null;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const youtubeId = getYouTubeId(url);
  if (youtubeId && YOUTUBE_ID_RE.test(youtubeId)) {
    return {
      provider: "youtube",
      src: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
    };
  }

  const vimeoId = getVimeoId(url);
  if (vimeoId && VIMEO_ID_RE.test(vimeoId)) {
    const hash = getVimeoHash(url);
    const hashQuery = hash && /^[A-Za-z0-9]+$/.test(hash) ? `?h=${hash}` : "";
    return {
      provider: "vimeo",
      src: `https://player.vimeo.com/video/${vimeoId}${hashQuery}`,
    };
  }

  return null;
}

export function normalizeVideoEmbedUrl(
  value: string | null | undefined,
): string | null {
  return normalizeVideoEmbed(value)?.src ?? null;
}
