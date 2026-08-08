import { useEffect, useRef, useState } from "react";

const ORDER_AUTO_REFRESH_SECONDS = 60;

interface OrderAutoRefreshCountdownProps {
  paused: boolean;
  onRefresh: () => boolean;
}

function isDocumentHidden() {
  return typeof document !== "undefined" && document.hidden;
}

export function OrderAutoRefreshCountdown({
  paused,
  onRefresh,
}: OrderAutoRefreshCountdownProps) {
  const [countdown, setCountdown] = useState(ORDER_AUTO_REFRESH_SECONDS);
  const countdownRef = useRef(ORDER_AUTO_REFRESH_SECONDS);
  const pausedRef = useRef(paused);
  const refreshRef = useRef(onRefresh);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (isDocumentHidden()) return;
      if (pausedRef.current) return;

      const next = countdownRef.current - 1;
      if (next <= 0) {
        countdownRef.current = ORDER_AUTO_REFRESH_SECONDS;
        setCountdown(ORDER_AUTO_REFRESH_SECONDS);
        refreshRef.current();
        return;
      }

      countdownRef.current = next;
      setCountdown(next);
    }, 1_000);

    const handleVisibilityChange = () => {
      if (isDocumentHidden()) return;
      refreshRef.current();
      countdownRef.current = ORDER_AUTO_REFRESH_SECONDS;
      setCountdown(ORDER_AUTO_REFRESH_SECONDS);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return (
    <span aria-live="polite" className="font-mono font-medium text-primary">
      {paused ? "Paused" : `${countdown}s`}
    </span>
  );
}
