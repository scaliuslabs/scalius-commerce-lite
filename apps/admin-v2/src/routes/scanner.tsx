import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ScannerApp } from "~/components/admin/scanner";

export const Route = createFileRoute("/scanner")({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no",
      },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "theme-color", content: "#0a0a0a" },
      { title: "Scalius Scanner" },
    ],
  }),
  component: ScannerPage,
});

function ScannerPage() {
  const [token, setToken] = useState<string | null>(null);
  const fragmentReadRef = useRef(false);

  useEffect(() => {
    if (fragmentReadRef.current) return;
    fragmentReadRef.current = true;

    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const scannerToken = fragment.get("token") ?? "";

    // Claim proofs live only in the fragment, which is not sent to the server
    // or in Referer headers. Scrub it before exchanging the proof.
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    setToken(scannerToken);
  }, []);

  return (
    <div className="dark bg-background text-foreground min-h-screen overflow-hidden">
      <div id="scanner-root">
        <ScannerApp token={token} />
      </div>
    </div>
  );
}
