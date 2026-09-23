import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

/** The one permission notice: "You can view this but not change it." */
export function ReadOnlyNotice() {
  const t = useMessages(resourceMessages);
  return (
    <p role="status" className="mb-4 rounded-lg border bg-muted px-4 py-2 text-body text-muted-foreground">
      {t("readOnly")}
    </p>
  );
}
