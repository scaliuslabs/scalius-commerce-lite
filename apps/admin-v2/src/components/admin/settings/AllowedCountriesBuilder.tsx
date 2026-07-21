import { useState, useEffect, useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import { Loader2, RotateCcw, Save, X, Search } from "lucide-react";
import { getServerFnError } from "@/lib/api-helpers";
import { getAllowedCountries, updateAllowedCountries } from "@/lib/api-functions/settings";
import { getCountries, getCountryCallingCode } from "react-phone-number-input";
import en from "react-phone-number-input/locale/en";
import type { Country } from "react-phone-number-input";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { UnsavedChangesGuard } from "../shared/UnsavedChangesGuard";

interface CountryOption {
  value: Country;
  label: string;
  callingCode: string;
}

const ALL_COUNTRIES: CountryOption[] = getCountries().map((code) => ({
  value: code,
  label: en[code] || code,
  callingCode: getCountryCallingCode(code),
}));

type CountryMode = "include" | "exclude";

export default function AllowedCountriesBuilder() {
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Country[]>([]);
  const [mode, setMode] = useState<CountryMode>("include");
  const [savedSelected, setSavedSelected] = useState<Country[]>([]);
  const [savedMode, setSavedMode] = useState<CountryMode>("include");
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getAllowedCountries() as Record<string, unknown>;
      const nextSelected = Array.isArray(data.allowedCountries)
        ? (data.allowedCountries as Country[])
        : [];
      const nextMode = data.allowedCountriesMode === "exclude"
        ? "exclude"
        : "include";
      setSelected(nextSelected);
      setMode(nextMode);
      setSavedSelected(nextSelected);
      setSavedMode(nextMode);
      setHasLoaded(true);
    } catch (error) {
      setHasLoaded(false);
      setLoadError(getServerFnError(error, "The current country policy could not be loaded."));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!hasLoaded || loadError) {
      toast.error("Reload the country policy before saving.");
      return;
    }
    setSaving(true);
    try {
      await updateAllowedCountries({ data: { allowedCountries: selected, mode } });
      setSavedSelected(selected);
      setSavedMode(mode);
      toast.success("Country policy saved");
    } catch (err) {
      toast.error(getServerFnError(err, "Failed to save allowed countries"));
    } finally {
      setSaving(false);
    }
  };

  const toggleCountry = (code: Country) => {
    setSelected((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const removeCountry = (code: Country) => {
    setSelected((prev) => prev.filter((c) => c !== code));
  };

  const filteredCountries = useMemo(() => {
    if (!search.trim()) return ALL_COUNTRIES;
    const q = search.toLowerCase();
    return ALL_COUNTRIES.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.value.toLowerCase().includes(q) ||
        `+${c.callingCode}`.includes(q),
    );
  }, [search]);

  const isDirty = useMemo(() => {
    if (mode !== savedMode || selected.length !== savedSelected.length) {
      return true;
    }
    const current = [...selected].sort();
    const saved = [...savedSelected].sort();
    return current.some((country, index) => country !== saved[index]);
  }, [mode, savedMode, savedSelected, selected]);

  const modeDescription = useMemo(() => {
    if (selected.length === 0) {
      return "No restriction. All countries are accepted.";
    }
    if (mode === "include") {
      return "Only these countries will be allowed for phone numbers.";
    }
    return "All countries except these are accepted.";
  }, [mode, selected.length]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <SettingsLoadFailure
        title="Country policy unavailable"
        error={loadError}
        fallback="The current allowed-country policy could not be loaded."
        onRetry={fetchSettings}
      />
    );
  }

  return (
    <div className="max-w-2xl space-y-5">
      <UnsavedChangesGuard isDirty={isDirty} isSubmitting={saving} />
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Customer Countries</CardTitle>
          <CardDescription>
            Limit calling codes accepted for customer and checkout phone numbers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Policy</Label>
            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as CountryMode)}
              className="flex flex-col gap-2 sm:flex-row sm:gap-6"
            >
              <div className="flex min-h-11 items-center gap-2">
                <RadioGroupItem value="include" id="mode-include" />
                <Label htmlFor="mode-include" className="font-normal cursor-pointer">
                  Only selected countries
                </Label>
              </div>
              <div className="flex min-h-11 items-center gap-2">
                <RadioGroupItem value="exclude" id="mode-exclude" />
                <Label htmlFor="mode-exclude" className="font-normal cursor-pointer">
                  All except selected countries
                </Label>
              </div>
            </RadioGroup>
          </div>

          {selected.length > 0 && (
            <div className="space-y-1.5">
              <Label>
                {mode === "include" ? "Allowed" : "Excluded"} ({selected.length})
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {selected.map((code) => {
                  const country = ALL_COUNTRIES.find((c) => c.value === code);
                  return (
                    <Badge
                      key={code}
                      variant="secondary"
                      className="gap-1 pr-1"
                    >
                      {country ? country.label : code} (+
                      {country ? country.callingCode : "?"})
                      <button
                        type="button"
                        onClick={() => removeCountry(code)}
                        aria-label={`Remove ${country ? country.label : code}`}
                        className="ml-0.5 grid size-8 shrink-0 place-items-center rounded-full hover:bg-muted-foreground/20 md:size-6"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </Badge>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="country-search">Search countries</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-3.5 h-4 w-4 text-muted-foreground md:top-2.5" />
              <Input
                id="country-search"
                placeholder="Search by name, code, or calling code..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="min-h-11 pl-9 md:min-h-9"
              />
            </div>
          </div>

          <div className="border rounded-md max-h-64 overflow-y-auto">
            {filteredCountries.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No countries match your search.
              </div>
            ) : (
              <div className="divide-y">
                {filteredCountries.map((country) => {
                  const isSelected = selected.includes(country.value);
                  return (
                    <button
                      key={country.value}
                      type="button"
                      onClick={() => toggleCountry(country.value)}
                      className={`flex min-h-11 w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50 ${
                        isSelected ? "bg-muted/30" : ""
                      }`}
                    >
                      <span>
                        {country.label}{" "}
                        <span className="text-muted-foreground">
                          (+{country.callingCode})
                        </span>
                      </span>
                      {isSelected && (
                        <Badge variant="default" className="text-xs">
                          {mode === "include" ? "Allowed" : "Excluded"}
                        </Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {modeDescription}
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2 border-t border-border pt-4 sm:flex sm:justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSelected(savedSelected);
            setMode(savedMode);
          }}
          disabled={saving || !isDirty}
          className="min-h-11 md:min-h-10"
        >
          <RotateCcw className="h-4 w-4" />
          Reset
        </Button>
        <Button
          onClick={handleSave}
          disabled={saving || !hasLoaded || !isDirty}
          className="min-h-11 min-w-[140px] md:min-h-10"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save country policy
        </Button>
      </div>
    </div>
  );
}
