import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { helpMessages } from "~/i18n/help";

/** Where help lives (the README's own links): questions go to the community, problems to the issue tracker. */
const HELP_LINKS = {
  questions: "https://scalius.com/discord",
  problem: "https://github.com/scaliuslabs/scalius-commerce-lite/issues",
} as const;

/**
 * Shopify's help menu: where to ask and report, then the keyboard shortcuts.
 * Loads when the help button is first used, off the shell's first download.
 */
export default function HelpMenu({ open, onOpenChange, trigger, onShortcuts }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  onShortcuts: () => void;
}) {
  const t = useMessages(helpMessages);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
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
