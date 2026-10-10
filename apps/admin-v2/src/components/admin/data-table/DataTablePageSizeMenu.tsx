import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

export interface PageSizeMenuProps {
  value: number;
  options: readonly number[];
  onChange: (size: number) => void;
}

/**
 * The pager's rows-per-page menu. Its own chunk: the menu library loads
 * after the list renders (the pager shows the same button meanwhile).
 */
export default function DataTablePageSizeMenu({ value, options, onChange }: PageSizeMenuProps) {
  const t = useMessages(resourceMessages);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          {t("perPage", { count: value })}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={String(value)} onValueChange={(next) => onChange(Number(next))}>
          {options.map((size) => (
            <DropdownMenuRadioItem key={size} value={String(size)}>
              {t("perPage", { count: size })}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
