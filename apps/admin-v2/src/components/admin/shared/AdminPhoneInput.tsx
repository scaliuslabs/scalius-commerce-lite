import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import PhoneInput, { type Country } from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { Loader2, RefreshCw } from "lucide-react";
import { FLAG_URL } from "@scalius/shared/phone-flags";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@scalius/shared/utils";
import {
  normalizePolicyCountries,
  resolveSelectablePhoneCountries,
} from "./admin-phone-country-policy";
import {
  getApiV1AdminSettingsAllowedCountries,
} from "@scalius/api-client/sdk";
import { apiData } from "@/lib/api";
import { useMessages } from "~/i18n";
import { appMessages } from "~/i18n/app";

type NativePhoneInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value"
>;

export interface AdminPhoneInputProps extends NativePhoneInputProps {
  value?: string;
  onChange: (value: string) => void;
  preserveExistingValue?: string | null;
}

export const AdminPhoneInput = React.forwardRef<
  HTMLInputElement,
  AdminPhoneInputProps
>(function AdminPhoneInput(
  {
    value,
    onChange,
    preserveExistingValue,
    className,
    disabled,
    ...inputProps
  },
  ref,
) {
  const t = useMessages(appMessages);
  const policyQuery = useQuery({
    queryKey: queryKeys.settings.allowedCountries(),
    queryFn: () => apiData(getApiV1AdminSettingsAllowedCountries()),
    staleTime: 2 * 60 * 1000,
    retry: false,
  });

  const policy = policyQuery.data;
  const configuredCountries = React.useMemo(
    () => normalizePolicyCountries(policy),
    [policy],
  );
  const hasActivePolicy = configuredCountries.length > 0;
  const selectableCountries = React.useMemo((): Country[] | undefined => {
    return resolveSelectablePhoneCountries(
      configuredCountries,
      policy?.allowedCountriesMode,
      preserveExistingValue,
    );
  }, [configuredCountries, policy?.allowedCountriesMode, preserveExistingValue]);
  const defaultCountry: Country = selectableCountries?.[0] ?? "BD";

  if (policyQuery.isPending) {
    return (
      <div
        role="status"
        className={cn(
          "flex h-11 w-full items-center gap-2 rounded-lg border border-input px-3 text-body text-muted-foreground sm:h-9",
          className,
        )}
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t("loading")}
      </div>
    );
  }

  if (policyQuery.isError) {
    return (
      <Button
        type="button"
        variant="outline"
        className={cn("w-full justify-start", className)}
        onClick={() => void policyQuery.refetch()}
        loading={policyQuery.isFetching}
      >
        <RefreshCw aria-hidden="true" />
        {t("phoneCountriesFailed")}
      </Button>
    );
  }

  return (
    <PhoneInput
      {...inputProps}
      // Runtime forwards this ref to the native input; the package declaration
      // still exposes its pre-forwardRef class instance type.
      ref={ref as unknown as React.Ref<React.ComponentRef<typeof PhoneInput>>}
      key={`${policy?.allowedCountriesMode ?? "include"}:${selectableCountries?.join(",") ?? "all"}`}
      international
      flagUrl={FLAG_URL}
      defaultCountry={defaultCountry}
      countries={selectableCountries}
      addInternationalOption={!hasActivePolicy}
      countryCallingCodeEditable={!hasActivePolicy}
      value={value}
      onChange={(nextValue) => onChange(nextValue || "")}
      disabled={disabled}
      autoComplete="tel"
      className={cn(
        "flex h-11 w-full rounded-lg border border-input bg-card px-3 text-body-lg sm:h-9 sm:text-body [&_.PhoneInputCountry]:h-full [&_.PhoneInputCountrySelect]:h-full [&_.PhoneInputInput]:h-full",
        className,
      )}
    />
  );
});
