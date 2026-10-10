import { Eye } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { useMessages } from "~/i18n";
import { statesMessages } from "~/i18n/states";
import { useStoreOwnerName } from "./store-owner";

/**
 * View-only access to a page (polish bar R5): one info banner at the top that
 * says so and who can grant edit access. The page then shows values as text
 * (`Field` read-only), never disabled inputs, and no create, delete or save
 * controls. See "Read-only mode" in DESIGN.md.
 */
export function ReadOnlyNotice({ ownerName: given }: { ownerName?: string | null }) {
  const t = useMessages(statesMessages);
  const fetched = useStoreOwnerName(given === undefined);
  const ownerName = given === undefined ? fetched : given;
  return (
    <Alert variant="info" data-slot="read-only-notice" role="status" className="mb-4">
      <Eye aria-hidden />
      <AlertTitle>{t("readOnly")}</AlertTitle>
      <AlertDescription>{ownerName ? t("askNamedEdit", { name: ownerName }) : t("askOwnerEdit")}</AlertDescription>
    </Alert>
  );
}
