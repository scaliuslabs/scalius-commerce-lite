// The header's "More actions" menu, loaded only by a page that folds actions into it.
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import type { PageAction } from "./PageHeader";

export default function PageHeaderMenu({ actions, className }: { actions: readonly PageAction[]; className?: string }) {
  const t = useMessages(resourceMessages);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" className={className}>
          {t("moreActions")}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          action.to ? (
            <DropdownMenuItem key={action.label} asChild disabled={action.disabled}>
              <Link to={action.to}>{action.icon}{action.label}</Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={action.label}
              disabled={action.disabled}
              variant={action.destructive ? "destructive" : undefined}
              onSelect={() => action.onAction?.()}
            >
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          )
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
