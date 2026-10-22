import { useState } from "react";
import { Plus } from "lucide-react";
import { getApiV1AdminInventorySuppliers } from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { SearchableSelect, type SearchableSelectLoader } from "~/components/ui/searchable-select";
import { apiData } from "~/lib/api";
import { purchasingKeys } from "~/lib/api-query-options/purchasing";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { SupplierDialog } from "./SupplierDialog";

export interface SupplierChoice {
  id: string;
  name: string;
}

const PAGE_SIZE = 20;

export const loadActiveSuppliers: SearchableSelectLoader = async ({ search, page }) => {
  const result = await apiData(getApiV1AdminInventorySuppliers({
    query: { status: "active", page, limit: PAGE_SIZE, ...(search ? { q: search } : {}) },
  }));
  return {
    options: result.suppliers.map((supplier) => ({
      value: supplier.id,
      label: supplier.name,
      description: [supplier.contactName, supplier.phone].filter(Boolean).join(" · ") || undefined,
    })),
    hasMore: page < result.pagination.totalPages,
  };
};

/** Choose an active supplier (searched on the server) or add one on the spot. */
export function SupplierPicker({
  value,
  onChange,
  id,
  disabled,
  canAdd,
}: {
  value: SupplierChoice | null;
  onChange: (supplier: SupplierChoice | null) => void;
  id?: string;
  disabled?: boolean;
  /** Staff who may add suppliers get the inline Add supplier button. */
  canAdd: boolean;
}) {
  const t = useMessages(purchasingMessages);
  const [adding, setAdding] = useState(false);
  const [session, setSession] = useState(0);
  // A name typed into the search that matched nobody starts the new supplier.
  const [typedName, setTypedName] = useState("");
  const startAdding = (name: string) => {
    setTypedName(name);
    setSession((current) => current + 1);
    setAdding(true);
  };
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <SearchableSelect
          id={id}
          triggerClassName="w-full"
          value={value?.id ?? ""}
          selectedLabel={value?.name}
          placeholder={t("chooseSupplier")}
          searchPlaceholder={t("searchSuppliersShort")}
          emptyMessage={t("noSuppliersFound")}
          emptyAction={canAdd ? { label: (name) => t("addSupplierNamed", { name }), onSelect: startAdding } : undefined}
          clearable
          disabled={disabled}
          load={loadActiveSuppliers}
          // Under the suppliers key, so adding or archiving one refreshes the choices.
          queryKey={[...purchasingKeys.suppliers(), "picker"]}
          onValueChange={(next, option) => onChange(next && option ? { id: next, name: option.label } : null)}
        />
      </div>
      {canAdd ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label={t("addSupplier")}
          disabled={disabled}
          onClick={() => startAdding("")}
        >
          <Plus />
        </Button>
      ) : null}
      <SupplierDialog
        key={session}
        supplier={null}
        initialName={typedName}
        open={adding}
        onOpenChange={setAdding}
        onSaved={(supplier) => onChange({ id: supplier.id, name: supplier.name })}
      />
    </div>
  );
}
