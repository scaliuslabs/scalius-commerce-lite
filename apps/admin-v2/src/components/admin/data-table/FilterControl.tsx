import { useId, type ReactElement, cloneElement } from "react";
import { Label } from "~/components/ui/label";

/**
 * One field of a list's "Filters" panel (`DataTableToolbar`): its label 4px
 * above the control (S2), the control full width. The control gets the
 * label's id as its accessible name.
 */
export function FilterControl({ label, children }: { label: string; children: ReactElement<{ id?: string; triggerClassName?: string }> }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children, { id, triggerClassName: "w-full" })}
    </div>
  );
}
