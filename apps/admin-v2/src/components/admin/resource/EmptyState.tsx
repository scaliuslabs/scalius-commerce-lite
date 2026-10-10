import type { ComponentProps } from "react";
import { EmptyState as StateEmpty } from "~/components/admin/states/EmptyState";

/**
 * @deprecated Import `EmptyState` (first use), `FilteredEmptyState` or
 * `SectionEmpty` from `components/admin/states`. This forwards the lists that
 * still call it (inside their card, no help link unless asked) and goes once
 * the list kit has moved them.
 */
export function EmptyState({ help = false, ...props }: Omit<ComponentProps<typeof StateEmpty>, "card">) {
  return <StateEmpty {...props} help={help} card={false} />;
}
