import { createFileRoute } from "@tanstack/react-router";
import { ScannerApp } from "~/components/admin/scanner";
import {
  normalizeOptionalSearchString,
  type SearchValidatorInput,
} from "~/lib/list-helpers";

type ScannerSearchParams = {
  token?: string;
};

function validateScannerSearch(
  search: SearchValidatorInput<ScannerSearchParams>,
): ScannerSearchParams {
  return {
    token: normalizeOptionalSearchString(search.token),
  };
}

export const Route = createFileRoute("/scanner")({
  validateSearch: validateScannerSearch,
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
  const { token } = Route.useSearch();

  return (
    <div className="dark bg-background text-foreground min-h-screen overflow-hidden">
      <div id="scanner-root">
        <ScannerApp token={token || ""} />
      </div>
    </div>
  );
}
