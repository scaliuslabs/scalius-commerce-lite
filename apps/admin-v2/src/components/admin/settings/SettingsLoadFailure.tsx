import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";

/** Load failure for one card. Saving stays locked until it loads. */
export function SettingsLoadFailure({
  title,
  onRetry,
}: {
  title: string;
  onRetry: () => void | Promise<unknown>;
}) {
  const t = useMessages(settingsMessages);
  return (
    <Alert variant="destructive" role="alert">
      <AlertTriangle className="size-4" aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{t("loadFailed")}</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void onRetry()}>
          {t("retry")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
