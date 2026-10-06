// A first-party app this store's code does not include yet: its listing and
// the one way to install it, the operator's `pnpm plugin add` command and an
// update of the store (bundled apps are part of the deployed code).
import { Button } from "~/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { useLocale, useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import type { AppListing } from "~/lib/api-query-options/apps";
import { AppIcon } from "./AppIcon";
import { AppListingFacts, AppScreenshots } from "./AppListingParts";
import { localizedApp } from "./app-text";

export function AvailableAppDialog({ app: listed, open, onOpenChange }: { app: AppListing | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(installedAppsMessages);
  const locale = useLocale();
  const app = listed ? localizedApp(listed, locale) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {app ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <AppIcon src={app.icon} size="lg" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <DialogTitle>{t("installTitle", { name: app.name })}</DialogTitle>
                  <DialogDescription>{t("byAuthor", { author: app.author.name })}</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {app.tagline ? <p className="text-body font-medium">{app.tagline}</p> : null}
              <p className="whitespace-pre-wrap break-words text-body">{app.description}</p>
              <AppScreenshots app={app} />
              <AppListingFacts app={app} />
              <div className="flex flex-col gap-1 border-t pt-4">
                <p className="text-body">{t("installBody")}</p>
                <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2"><code>{app.installCommand}</code></pre>
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button">{t("done")}</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
