import { getApiV1AdminCustomers } from "@scalius/api-client/sdk";
import { SearchableSelect, type SearchableSelectLoader } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { giftCardsMessages } from "~/i18n/gift-cards";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";

const PAGE_SIZE = 20;

/** Customers searched on the server (name, phone or email) and paged; the search never enters the page URL. */
const loadCustomers: SearchableSelectLoader = async ({ search, page, signal }) => {
  const result = await apiData(getApiV1AdminCustomers({ query: { page, limit: PAGE_SIZE, ...(search ? { search } : {}) }, signal }));
  return {
    options: result.customers.map((customer) => ({
      value: customer.id,
      label: customer.name || customer.phone,
      description: [customer.phone, customer.email].filter(Boolean).join(" · "),
    })),
    hasMore: page < result.pagination.totalPages,
  };
};

/** The customer a gift card belongs to: it shows in their account. */
export function GiftCardCustomerPicker({ id, value, selectedLabel, onChange, disabled, describedBy }: {
  id: string;
  value: string;
  /** The saved customer's name while their page of results isn't loaded. */
  selectedLabel?: string;
  onChange: (customer: { id: string; name: string } | null) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const t = useMessages(giftCardsMessages);
  return (
    <SearchableSelect
      id={id}
      value={value}
      selectedLabel={selectedLabel}
      load={loadCustomers}
      queryKey={[...queryKeys.customers.all, "gift-card-picker"]}
      placeholder={t("customerPlaceholder")}
      searchPlaceholder={t("customerSearch")}
      emptyMessage={t("noCustomers")}
      clearable
      disabled={disabled}
      aria-describedby={describedBy}
      triggerClassName="w-full"
      onValueChange={(next, option) => onChange(next && option ? { id: next, name: option.label } : null)}
    />
  );
}
