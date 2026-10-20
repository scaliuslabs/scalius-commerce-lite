// Home's "More actions" menu. It is drawn only while this staff member has
// dismissed the setup guide, and loads on its own so Home's first download
// carries no menu code.
import { MoreHorizontal } from "lucide-react";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { setupGuideMessages } from "~/i18n/setup-guide";
import { useShowSetupGuide } from "./use-show-setup-guide";

export default function HomeMoreActions() {
  const t = useMessages(setupGuideMessages);
  const show = useShowSetupGuide();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="icon" aria-label={t("moreActions")} disabled={show.isPending}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => show.mutate()}>{t("showGuide")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
