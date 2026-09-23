import { useState } from "react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { Button } from "~/components/ui/button";
import { broadcastAdminSignOut } from "~/components/auth/AdminSessionSync";
import { translate, useMessages } from "~/i18n";
import { appMessages } from "~/i18n/app";
import { clearAdminRouteContextCache } from "~/lib/admin-route-context";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { NotFoundState, PageState } from "~/lib/route-error";

export const Route = createFileRoute("/admin/access-denied")({
  head: () => ({ meta: [{ title: translate(appMessages, "forbiddenTitle") }] }),
  component: AccessDeniedPage,
});

const adminRoute = getRouteApi("/admin");

function AccessDeniedPage() {
  const { hasAdminAccess } = adminRoute.useRouteContext();
  // Someone with any permission has a Home to go back to.
  return hasAdminAccess ? <NotFoundState forbidden /> : <NoAccess />;
}

/** An account with no permissions at all: Home would only lead back here, so the way out is signing out. */
function NoAccess() {
  const t = useMessages(appMessages);
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    setSigningOut(true);
    clearAdminRouteContextCache();
    try {
      const { authClient } = await import("~/lib/auth-client");
      await authClient.signOut();
      broadcastAdminSignOut();
    } catch {
      // The sign-in page reads the session again and sends a live one back here.
    }
    window.location.replace(withDashboardBasePath("/auth/login"));
  };
  return (
    <PageState
      icon={Lock}
      title={t("forbiddenTitle")}
      body={t("noAccessBody")}
      action={
        <Button loading={signingOut} onClick={() => void signOut()}>
          {t("signOut")}
        </Button>
      }
    />
  );
}
