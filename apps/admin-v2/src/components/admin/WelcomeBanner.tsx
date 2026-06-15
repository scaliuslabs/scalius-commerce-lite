//src/components/admin/WelcomeBanner.tsx

import React from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { X as CloseIcon, PartyPopper } from "lucide-react";
import { BackgroundGradient } from "../ui/background-gradient";
import { ContainerTextFlip } from "../ui/container-text-flip";

export function WelcomeBanner() {
  const [showBanner, setShowBanner] = React.useState(true);

  React.useEffect(() => {
    const storageKey = "welcomeBannerDismissedUntil";
    const dismissedUntil = sessionStorage.getItem(storageKey);
    if (dismissedUntil && Date.now() < parseInt(dismissedUntil, 10)) {
      setShowBanner(false);
    } else if (dismissedUntil) {
      sessionStorage.removeItem(storageKey);
    }
  }, []);

  const handleDismissBanner = React.useCallback(() => {
    const storageKey = "welcomeBannerDismissedUntil";
    const dismissDuration = 60 * 60 * 1000; // 60 minutes
    const reappearTime = Date.now() + dismissDuration;
    sessionStorage.setItem(storageKey, reappearTime.toString());
    setShowBanner(false);
  }, []);

  if (!showBanner) {
    return null;
  }

  return (
    <ErrorBoundary fallback={null}>
    <div className="relative mb-4 rounded-2xl overflow-hidden">
      <BackgroundGradient
        containerClassName="rounded-2xl"
        className="rounded-2xl p-4 bg-card"
      >
        <button
          onClick={() => {
            handleDismissBanner();
          }}
          aria-label="Dismiss welcome message"
          className="absolute right-4 top-4 z-20 p-1.5 rounded-full text-gray-600 dark:text-gray-400 hover:bg-gray-200/70 dark:hover:bg-gray-700/70 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-white pointer-events-auto"
        >
          <CloseIcon className="h-5 w-5" />
        </button>

        <div className="relative z-10 flex items-center gap-3">
          <PartyPopper className="w-7 h-7 text-primary/80 shrink-0" />
          <div>
            <ContainerTextFlip
              words={[
                "Welcome Back!",
                "Let's Grow!",
                "Stats Ready!",
                "Manage Store!",
                "Good Day!",
              ]}
              className="flex items-center text-xl font-semibold tracking-tight text-gray-800 dark:text-gray-100 pt-0! pb-0! text-left! shadow-none! bg-none! dark:bg-none! dark:shadow-none!"
              textClassName="text-xl font-semibold tracking-tight text-gray-800 dark:text-gray-100"
              interval={2500}
              animationDuration={500}
            />
            <p className="mt-0.5 max-w-xl text-sm leading-relaxed text-gray-600 dark:text-gray-300">
              Your dashboard is ready. Manage orders, products, and view key
              stats.
            </p>
          </div>
        </div>
      </BackgroundGradient>
    </div>
    </ErrorBoundary>
  );
}
