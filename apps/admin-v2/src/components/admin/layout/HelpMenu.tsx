import { CircleHelp } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { helpMessages } from "~/i18n/help";
import { TOP_BAR_BUTTON } from "./nav-button";

/** Where help lives (the README's own links): questions go to the community, problems to the issue tracker. */
const HELP_LINKS = {
  questions: "https://scalius.com/discord",
  problem: "https://github.com/scaliuslabs/scalius-commerce-lite/issues",
} as const;

/**
 * Shopify's help button and menu: where to ask and report, then the keyboard
 * shortcuts. Loads after the shell, like the notification bell.
 */
export default function HelpMenu({ onShortcuts }: { onShortcuts: () => void }) {
  const t = useMessages(helpMessages);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={t("help")} className={cn(TOP_BAR_BUTTON, "hidden md:flex")}>
          <CircleHelp aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <a href={HELP_LINKS.questions} target="_blank" rel="noopener noreferrer">{t("questions")}</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={HELP_LINKS.problem} target="_blank" rel="noopener noreferrer">{t("problem")}</a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onShortcuts} aria-keyshortcuts="?">{t("shortcuts")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
