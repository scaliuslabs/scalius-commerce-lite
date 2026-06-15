import { cn } from "@scalius/shared/utils";
import React from "react";

export const BackgroundGradient = ({
  children,
  className,
  containerClassName,
  animate = true,
}: {
  children?: React.ReactNode;
  className?: string;
  containerClassName?: string;
  animate?: boolean;
}) => {
  const gradientStyle = animate
    ? {
        backgroundSize: "400% 400%",
      }
    : undefined;

  return (
    <div className={cn("relative p-[4px] group", containerClassName)}>
      <div
        aria-hidden="true"
        style={gradientStyle}
        className={cn(
          "pointer-events-none absolute inset-0 rounded-3xl z-[1] opacity-80 group-hover:opacity-100 blur-2xl transition duration-500",
          " bg-[radial-gradient(circle_farthest-side_at_0_100%,#00ccb1,transparent),radial-gradient(circle_farthest-side_at_100%_0,#7b61ff,transparent),radial-gradient(circle_farthest-side_at_100%_100%,#ffc414,transparent),radial-gradient(circle_farthest-side_at_0_0,#1ca0fb,#141316)]",
        )}
      />
      <div
        aria-hidden="true"
        style={gradientStyle}
        className={cn(
          "pointer-events-none absolute inset-0 rounded-3xl z-[1]",
          "bg-[radial-gradient(circle_farthest-side_at_0_100%,#00ccb1,transparent),radial-gradient(circle_farthest-side_at_100%_0,#7b61ff,transparent),radial-gradient(circle_farthest-side_at_100%_100%,#ffc414,transparent),radial-gradient(circle_farthest-side_at_0_0,#1ca0fb,#141316)]",
        )}
      />

      <div className={cn("relative z-10", className)}>{children}</div>
    </div>
  );
};
