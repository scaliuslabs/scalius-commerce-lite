import type { VideoHTMLAttributes } from "react";
import { cn } from "@scalius/shared/utils";

type VideoPlayerProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, "children" | "className" | "controls"> & {
  className?: string;
  videoClassName?: string;
};

/** Native video with the browser's own controls. */
export function VideoPlayer({ className, videoClassName, ...videoProps }: VideoPlayerProps) {
  return (
    <div className={cn("block size-full overflow-hidden rounded-lg bg-black", className)}>
      <video {...videoProps} controls className={cn("size-full object-contain", videoClassName)}>
        Your browser does not support this video.
      </video>
    </div>
  );
}
