import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";

export function ProductStatusBadge({ isActive }: { isActive: boolean }) {
  const t = useMessages(productMessages);
  return (
    <StatusBadge status={isActive ? "active" : "draft"} className="shrink-0">
      {t(isActive ? "statusActive" : "statusDraft")}
    </StatusBadge>
  );
}
