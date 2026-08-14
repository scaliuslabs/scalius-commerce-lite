import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ExternalLink, Loader2, ShieldCheck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ADMIN_ACCESS_DENIED_PATH } from "~/lib/admin-access";
import { apiPost } from "~/lib/api";
import { getFreshAdminRouteContext } from "~/lib/admin-route-context";
import { RouteErrorComponent } from "~/lib/route-error";

interface BrowserAction {
  url: string;
  method: "POST";
  fields: Record<string, string>;
}

const getTrustedStorefrontOrigin = createServerFn({ method: "GET" }).handler(
  async () => {
    const { env } = await import("cloudflare:workers");
    const configured = (env as Env).STOREFRONT_URL;
    if (!configured) throw new Error("Storefront continuation is not configured");
    const url = new URL(configured);
    if (
      (url.protocol !== "https:" && url.hostname !== "localhost") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Storefront continuation origin is invalid");
    }
    return url.origin;
  },
);

export function isSafeBrowserAction(
  action: unknown,
  trustedStorefrontOrigin: string,
): action is BrowserAction {
  if (!action || typeof action !== "object") return false;
  const candidate = action as Partial<BrowserAction>;
  if (
    candidate.method !== "POST" ||
    typeof candidate.url !== "string" ||
    !candidate.fields ||
    typeof candidate.fields !== "object" ||
    Array.isArray(candidate.fields)
  ) return false;
  try {
    const destination = new URL(candidate.url);
    return (
      destination.origin === trustedStorefrontOrigin &&
      destination.protocol === "https:" &&
      !destination.username &&
      !destination.password &&
      !destination.search &&
      !destination.hash &&
      Object.keys(candidate.fields).length > 0 &&
      Object.keys(candidate.fields).length <= 12 &&
      Object.entries(candidate.fields).every(([name, value]) => (
        /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) &&
        typeof value === "string" &&
        value.length <= 512
      ))
    );
  } catch {
    return false;
  }
}

export async function requireFreshBrowserHandoffAuthority() {
  const context = await getFreshAdminRouteContext();
  if (!context.isSuperAdmin) {
    throw redirect({ to: ADMIN_ACCESS_DENIED_PATH, replace: true });
  }
  return context;
}

export const Route = createFileRoute(
  "/admin/settings/agent-access/continue/$handoffId",
)({
  beforeLoad: requireFreshBrowserHandoffAuthority,
  loader: () => getTrustedStorefrontOrigin(),
  head: () => ({
    meta: [
      { title: "Continue securely | Scalius Admin" },
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex,nofollow,noarchive" },
    ],
  }),
  errorComponent: RouteErrorComponent,
  component: BrowserHandoffRoute,
});

function BrowserHandoffRoute() {
  const { handoffId } = Route.useParams();
  const trustedStorefrontOrigin = Route.useLoaderData();
  const [status, setStatus] = useState<"ready" | "loading" | "opened" | "error">("ready");

  const continueSecurely = async () => {
    setStatus("loading");
    const popup = window.open("about:blank", "scalius-secure-continuation");
    if (!popup) {
      setStatus("error");
      return;
    }
    try {
      const result = await apiPost<{ action: BrowserAction }>(
        `/agent-access/browser-handoffs/${encodeURIComponent(handoffId)}`,
      );
      if (!isSafeBrowserAction(result.action, trustedStorefrontOrigin)) {
        throw new Error("Unsafe browser action");
      }
      const destination = new URL(result.action.url);
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", receive);
        popup.close();
        setStatus("error");
      }, 20_000);
      const receive = (event: MessageEvent) => {
        if (event.source !== popup || event.origin !== destination.origin || !event.data) return;
        if (event.data.type === "scalius-continuation-ready-v1") {
          popup.postMessage(
            { type: "scalius-continuation-fields-v1", fields: result.action.fields },
            destination.origin,
          );
        } else if (event.data.type === "scalius-continuation-accepted-v1") {
          window.clearTimeout(timeout);
          window.removeEventListener("message", receive);
          setStatus("opened");
        }
      };
      window.addEventListener("message", receive);
      popup.location.replace(destination.toString());
    } catch {
      popup.close();
      setStatus("error");
    }
  };

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl items-center px-3 py-8">
      <Card className="w-full shadow-none">
        <CardHeader>
          <span className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <CardTitle>Continue securely in Scalius</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This one-use step stays in your current 2FA-verified dashboard session.
            No credential is stored in this page or included in its URL.
          </p>
          {status === "error" ? (
            <Alert variant="destructive">
              <AlertTitle>Secure handoff unavailable</AlertTitle>
              <AlertDescription>
                It may have expired or already been used. Run the agent operation again.
              </AlertDescription>
            </Alert>
          ) : null}
          {status === "opened" ? (
            <Alert>
              <ShieldCheck aria-hidden="true" />
              <AlertTitle>Secure browser step opened</AlertTitle>
              <AlertDescription>You can close this page after completing the new tab.</AlertDescription>
            </Alert>
          ) : null}
          <Button
            type="button"
            className="min-h-11 w-full sm:min-h-9"
            disabled={status === "loading" || status === "opened"}
            onClick={() => void continueSecurely()}
          >
            {status === "loading" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <ExternalLink aria-hidden="true" />
            )}
            {status === "loading" ? "Preparing secure handoff…" : "Continue"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
