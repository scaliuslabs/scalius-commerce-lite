import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { AccessPage } from "~/components/admin/agent-access";
import { SettingsCard } from "~/components/admin/settings/SettingsPage";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";
import { ADMIN_ACCESS_DENIED_PATH } from "~/lib/admin-access";
import {
  getApiV1Platform,
  postApiV1AdminAgentAccessBrowserHandoffsByHandoffId,
} from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";
import { getFreshAdminRouteContext } from "~/lib/admin-route-context";
import { RouteErrorComponent } from "~/lib/route-error";

interface BrowserAction {
  url: string;
  method: "POST";
  fields: Record<string, string>;
}

/** The Platform storefront URL, as resolved by the API Worker serving this page. */
async function getTrustedStorefrontOrigin(): Promise<string> {
  const { storefrontUrl } = await apiData(getApiV1Platform());
  if (!storefrontUrl) throw new Error("Storefront continuation is not configured");
  const url = new URL(storefrontUrl);
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
}

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

/** The handoff runs inside a fresh Super Admin session. */
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
  const t = useMessages(aiAccessMessages);
  const [status, setStatus] = useState<"ready" | "loading" | "opened" | "error">("ready");

  const continueSecurely = async () => {
    setStatus("loading");
    const popup = window.open("about:blank", "scalius-secure-continuation");
    if (!popup) {
      setStatus("error");
      return;
    }
    try {
      const result = await apiData(postApiV1AdminAgentAccessBrowserHandoffsByHandoffId({
        path: { handoffId },
      }));
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
    <AccessPage title={t("continueTitle")}>
      <SettingsCard title={t("continueDescription")}>
        {status === "error" ? (
          <p role="alert" className="text-body text-destructive">{t("continueFailed")}</p>
        ) : null}
        {status === "opened" ? (
          <p role="status" className="text-body text-muted-foreground">{t("continueOpened")}</p>
        ) : null}
        <Button
          type="button"
          className="w-full sm:w-fit"
          disabled={status === "loading" || status === "opened"}
          onClick={() => void continueSecurely()}
        >
          {status === "loading" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {t("continue")}
        </Button>
      </SettingsCard>
    </AccessPage>
  );
}
