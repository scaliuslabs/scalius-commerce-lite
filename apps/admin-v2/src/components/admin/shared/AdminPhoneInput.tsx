import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import PhoneInput, { type Country } from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { Loader2, RefreshCw } from "lucide-react";
import { FLAG_URL } from "@scalius/shared/phone-flags";
import { Button } from "@/components/ui/button";
import { getAllowedCountries } from "@/lib/api-functions/settings";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@scalius/shared/utils";
import {
  normalizePolicyCountries,
  resolveSelectablePhoneCountries,
} from "./admin-phone-country-policy";

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
  const policyQuery = useQuery({
    queryKey: queryKeys.settings.allowedCountries(),
    queryFn: () => getAllowedCountries(),
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
        aria-label="Loading country policy"
        className={cn(
          "flex h-11 w-full items-center gap-2 rounded-md border border-input px-3 text-sm text-muted-foreground sm:h-9",
          className,
        )}
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading…
      </div>
    );
  }

  if (policyQuery.isError) {
    return (
      <Button
        type="button"
        variant="outline"
        className={cn("h-11 w-full justify-start gap-2 sm:h-9", className)}
        onClick={() => void policyQuery.refetch()}
        disabled={policyQuery.isFetching}
      >
        {policyQuery.isFetching ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw className="size-4" aria-hidden="true" />
        )}
        Retry country policy
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
        "flex h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm sm:h-9 [&_.PhoneInputCountry]:h-full [&_.PhoneInputCountrySelect]:h-full [&_.PhoneInputInput]:h-full",
        className,
      )}
    />
  );
});
