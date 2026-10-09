import type { ReactNode } from "react";
import { Link, useMatch } from "@tanstack/react-router";
import { FileQuestion, Lock } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { statesMessages } from "~/i18n/states";
import { recordListHref, recordResource, type RecordResource } from "./record-resource";
import { StateBlock } from "./StateBlock";

/** A page-sized state: a card on the page, or the whole window when the shell itself is gone. */
function PageCard({ fullPage, children }: { fullPage: boolean; children: ReactNode }) {
  return fullPage ? (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <Card className="w-full max-w-lg">{children}</Card>
    </main>
  ) : (
    <Card>{children}</Card>
  );
}

/**
 * A record that is gone (polish bar R2): "This gift card doesn't exist or was
 * deleted" and a way back to its list. The record and the list come from the
 * current route (`record-resource.ts`); pass `resource` to name another.
 */
export function RecordNotFound({ resource: given }: { resource?: RecordResource }) {
  const t = useMessages(statesMessages);
  const match = useMatch({ strict: false, select: (current) => ({ fullPath: current.fullPath, params: current.params }) });
  const resource = given ?? recordResource(match.fullPath);
  if (!resource) return <PageNotFound />;
  return (
    <PageCard fullPage={false}>
      <StateBlock
        slot="error-state"
        kind="not-found"
        icon={FileQuestion}
        title={t("recordNotFound", { noun: t(`noun.${resource.noun}`) })}
        titleAs="h1"
        description={t("recordNotFoundBody")}
        actions={
          <Button asChild>
            <Link to={recordListHref(resource, match.params as Record<string, string>)}>
              {t("backTo", { list: t(`list.${resource.noun}`) })}
            </Link>
          </Button>
        }
      />
    </PageCard>
  );
}

/** An address that is no page at all: the way out is Home. */
export function PageNotFound({ fullPage = false }: { fullPage?: boolean }) {
  const t = useMessages(statesMessages);
  return (
    <PageCard fullPage={fullPage}>
      <StateBlock
        slot="error-state"
        kind="not-found"
        icon={FileQuestion}
        title={t("pageNotFound")}
        titleAs="h1"
        description={t("pageNotFoundBody")}
        actions={
          <Button asChild>
            <Link to="/admin">{t("goHome")}</Link>
          </Button>
        }
      />
    </PageCard>
  );
}

/**
 * No permission for a page (R4): names the area when known and who can
 * grant access. `action` replaces "Go to Home" (an account with no access at
 * all signs out instead).
 */
export function NoPermissionState({
  area,
  ownerName,
  description,
  action,
  fullPage = false,
}: {
  area?: string;
  ownerName?: string | null;
  description?: string;
  action?: ReactNode;
  fullPage?: boolean;
}) {
  const t = useMessages(statesMessages);
  return (
    <PageCard fullPage={fullPage}>
      <StateBlock
        slot="error-state"
        kind="no-permission"
        icon={Lock}
        title={area ? t("noPermissionArea", { area }) : t("noPermissionTitle")}
        titleAs="h1"
        description={description ?? (ownerName ? t("askNamedAccess", { name: ownerName }) : t("askOwnerAccess"))}
        actions={
          action ?? (
            <Button asChild>
              <Link to="/admin">{t("goHome")}</Link>
            </Button>
          )
        }
      />
    </PageCard>
  );
}
