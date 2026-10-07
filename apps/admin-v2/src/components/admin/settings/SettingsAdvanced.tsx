import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";

/**
 * Controls most merchants never need, behind one quiet row under the cards
 * (Shopify's "Advanced" sections). Closed until opened; `forceOpen` keeps it
 * open while one of its fields has a problem, so Save never points at a hidden field.
 */
export function SettingsAdvanced({ label, forceOpen = false, defaultOpen = false, children }: {
  label: ReactNode;
  forceOpen?: boolean;
  /** Open at first, for a store that already uses what is inside. */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open || forceOpen} onOpenChange={setOpen}>
      <div className="flex flex-col gap-4">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" className="group -ms-3 self-start">
            <ChevronRight className="size-4 transition-transform group-aria-expanded:rotate-90" aria-hidden="true" />
            {label}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-4">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
