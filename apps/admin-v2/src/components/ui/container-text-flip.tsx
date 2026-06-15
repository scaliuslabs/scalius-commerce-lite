import { useEffect, useMemo, useState } from "react";

import { cn } from "@scalius/shared/utils";

export interface ContainerTextFlipProps {
  /** Array of words to cycle through in the animation */
  words?: string[];
  /** Time in milliseconds between word transitions */
  interval?: number;
  /** Additional CSS classes to apply to the container */
  className?: string;
  /** Additional CSS classes to apply to the text */
  textClassName?: string;
  /** Duration of the transition animation in milliseconds */
  animationDuration?: number;
}

const DEFAULT_FLIP_WORDS = ["better", "modern", "beautiful", "awesome"];

export function ContainerTextFlip({
  words = DEFAULT_FLIP_WORDS,
  interval = 3000,
  className,
  textClassName,
  animationDuration = 700,
}: ContainerTextFlipProps) {
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const displayWords = useMemo(() => (words.length > 0 ? words : [""]), [words]);
  const currentWord = displayWords[currentWordIndex % displayWords.length] ?? "";
  const minWidth = useMemo(
    () => `${Math.max(...displayWords.map((word) => word.length), 1)}ch`,
    [displayWords],
  );

  useEffect(() => {
    const intervalId = setInterval(() => {
      setCurrentWordIndex((prevIndex) => (prevIndex + 1) % displayWords.length);
    }, interval);

    return () => clearInterval(intervalId);
  }, [displayWords.length, interval]);

  useEffect(() => {
    setCurrentWordIndex((index) => index % displayWords.length);
  }, [displayWords.length]);

  return (
    <span
      className={cn(
        "relative inline-block rounded-lg pt-2 pb-3 text-center text-4xl font-bold text-black md:text-7xl dark:text-white transition-[min-width] ease-out",
        "[background:linear-gradient(to_bottom,#f3f4f6,#e5e7eb)]",
        "shadow-[inset_0_-1px_#d1d5db,inset_0_0_0_1px_#d1d5db,_0_4px_8px_#d1d5db]",
        "dark:[background:linear-gradient(to_bottom,#374151,#1f2937)]",
        "dark:shadow-[inset_0_-1px_#10171e,inset_0_0_0_1px_hsla(205,89%,46%,.24),_0_4px_8px_#00000052]",
        className,
      )}
      style={{
        minWidth,
        transitionDuration: `${Math.max(animationDuration, 0)}ms`,
      }}
    >
      <span
        key={currentWord}
        className={cn("inline-block animate-in fade-in-0 slide-in-from-bottom-1", textClassName)}
        style={{ animationDuration: `${Math.max(animationDuration, 0)}ms` }}
      >
        {currentWord}
      </span>
    </span>
  );
}
