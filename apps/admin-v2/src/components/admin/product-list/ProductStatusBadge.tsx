import { Badge } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";

export function ProductStatusBadge({ isActive }: { isActive: boolean }) {
  const t = useMessages(productMessages);
  return (
    <Badge variant={isActive ? "success" : "attention"} className="shrink-0">
      {t(isActive ? "statusActive" : "statusDraft")}
    </Badge>
  );
}
