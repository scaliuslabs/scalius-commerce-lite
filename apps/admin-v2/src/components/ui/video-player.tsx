import {
  createElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type VideoHTMLAttributes,
} from "react";
import { cn } from "@scalius/shared/utils";

const VIDEO_THEME_TAG = "media-theme-minimal";
let videoThemePromise: Promise<void> | null = null;

function loadVideoTheme(): Promise<void> {
  if (typeof customElements === "undefined") return Promise.resolve();
  if (customElements.get(VIDEO_THEME_TAG)) return Promise.resolve();
  if (!videoThemePromise) {
    videoThemePromise = import("@player.style/minimal")
      .then(() => customElements.whenDefined(VIDEO_THEME_TAG))
      .then(() => undefined)
      .catch((error: unknown) => {
        videoThemePromise = null;
        throw error;
      });
  }
  return videoThemePromise;
}

type VideoPlayerProps = Omit<
  VideoHTMLAttributes<HTMLVideoElement>,
  "children" | "className" | "controls"
> & {
  className?: string;
  videoClassName?: string;
};

const themeStyle = {
  "--media-primary-color": "rgb(255 255 255 / 0.96)",
  "--media-secondary-color": "rgb(0 0 0 / 0.82)",
} as CSSProperties;

/**
 * A progressively enhanced native video. The browser controls remain usable
 * until the shared theme is ready, and stay in place if its lazy chunk fails.
 */
export function VideoPlayer({
  className,
  videoClassName,
  ...videoProps
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [enhanced, setEnhanced] = useState(false);

  useEffect(() => {
    let active = true;
    const video = videoRef.current;
    void loadVideoTheme()
      .then(() => {
        if (active) setEnhanced(true);
      })
      .catch(() => {
        // Native controls are the intentional offline/chunk-error fallback.
      });
    return () => {
      active = false;
      video?.pause();
    };
  }, []);

  return createElement(
    VIDEO_THEME_TAG,
    {
      className: cn(
        "block h-full w-full overflow-hidden rounded-md bg-black",
        className,
      ),
      style: themeStyle,
      "data-video-player": "admin",
      "data-enhanced": enhanced ? "true" : undefined,
    },
    <video
      {...videoProps}
      ref={videoRef}
      slot="media"
      controls={!enhanced}
      className={cn("h-full w-full object-contain", videoClassName)}
    >
      Your browser does not support this video.
    </video>,
  );
}
