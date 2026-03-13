//src/components/admin/WelcomeBanner.tsx
"use client"; // Ensure this runs client-side

import React from "react";
import { X as CloseIcon, PartyPopper } from "lucide-react";
import { BackgroundGradient } from "../ui/background-gradient"; // Import the new component
import { ContainerTextFlip } from "../ui/container-text-flip"; // Import Text Flip

// Function to safely check sessionStorage for initial visibility
const getInitialVisibility = () => {
  // Only run this logic in the browser
  if (typeof window !== "undefined" && typeof sessionStorage !== "undefined") {
    const storageKey = "welcomeBannerDismissedUntil";
    const dismissedUntil = sessionStorage.getItem(storageKey);
    if (dismissedUntil && Date.now() < parseInt(dismissedUntil, 10)) {
      return false; // Should be hidden initially
    }
  }
  return true; // Default to visible
};

export function WelcomeBanner() {
  // Initialize state directly using the check function
  const [showBanner, setShowBanner] = React.useState(getInitialVisibility);

  // Effect for Handling Expiration and as Fallback
  React.useEffect(() => {
    const storageKey = "welcomeBannerDismissedUntil";
    const dismissedUntil = sessionStorage.getItem(storageKey);
    const shouldBeVisible = !(
      dismissedUntil && Date.now() < parseInt(dismissedUntil, 10)
    );

    // If state mismatches (e.g., expired dismissal), update it.
    if (showBanner !== shouldBeVisible) {
      setShowBanner(shouldBeVisible);
      if (shouldBeVisible && dismissedUntil) {
        sessionStorage.removeItem(storageKey); // Clean up expired timestamp
      }
    } else if (!shouldBeVisible) {
    } else {
    }
  }, []); // Run only on mount

  // Handler for dismissing the banner - wrapped in useCallback
  const handleDismissBanner = React.useCallback(() => {
    const storageKey = "welcomeBannerDismissedUntil";
    const dismissDuration = 60 * 60 * 1000; // 60 minutes
    const reappearTime = Date.now() + dismissDuration;
    sessionStorage.setItem(storageKey, reappearTime.toString());
    setShowBanner(false);
  }, []);

  // Early return if banner shouldn't be shown
  if (!showBanner) {
    return null;
  }

  return (
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
          // Keep the button visible above the gradient
          className="absolute right-4 top-4 z-20 p-1.5 rounded-full text-gray-600 dark:text-gray-400 hover:bg-gray-200/70 dark:hover:bg-gray-700/70 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-white pointer-events-auto"
        >
          <CloseIcon className="h-5 w-5" />
        </button>

        {/* Content remains relative but inside the gradient */}
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
  );
}
