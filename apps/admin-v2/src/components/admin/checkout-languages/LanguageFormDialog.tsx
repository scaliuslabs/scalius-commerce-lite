import { useState, useEffect } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "~/components/ui/dialog";
import { Loader2 } from "lucide-react";
import {
  type ManagerCheckoutLanguage,
  defaultLanguageData,
  defaultFieldVisibility,
} from "./hooks/useLanguages";

interface LanguageFormDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  editingLanguage: ManagerCheckoutLanguage | null;
  isActionLoading: boolean;
  onSubmit: (
    formData: Partial<ManagerCheckoutLanguage>,
    editingLanguageId: string | null,
  ) => Promise<boolean>;
}

export function LanguageFormDialog({
  isOpen,
  onOpenChange,
  editingLanguage,
  isActionLoading,
  onSubmit,
}: LanguageFormDialogProps) {
  const [currentFormData, setCurrentFormData] = useState<
    Partial<ManagerCheckoutLanguage>
  >(() => getInitialFormData(editingLanguage));

  // Reset form data when editingLanguage changes
  const resetForm = (lang: ManagerCheckoutLanguage | null) => {
    setCurrentFormData(getInitialFormData(lang));
  };

  // Sync form data when editingLanguage prop changes (e.g., switching from one language to another)
  useEffect(() => {
    resetForm(editingLanguage);
  }, [editingLanguage]);

  const handleFormSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const success = await onSubmit(currentFormData, editingLanguage?.id || null);
    if (success) {
      onOpenChange(false);
    }
  };

  const updateLanguageData = (key: string, value: string) => {
    setCurrentFormData((prev) => ({
      ...prev,
      languageData: {
        ...prev.languageData,
        [key]: value,
      },
    }));
  };

  const updateFieldVisibility = (key: string, value: boolean) => {
    setCurrentFormData((prev) => ({
      ...prev,
      fieldVisibility: {
        ...prev.fieldVisibility,
        [key]: value,
      },
    }));
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        onOpenChange(open);
        if (open) resetForm(editingLanguage);
      }}
    >
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editingLanguage ? "Edit" : "Create"} Checkout Language
          </DialogTitle>
          <DialogDescription>
            Configure language settings, field labels, and visibility options.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleFormSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="name" className="text-xs">
                Language Name
              </Label>
              <Input
                id="name"
                value={currentFormData.name || ""}
                onChange={(e) =>
                  setCurrentFormData((p) => ({ ...p, name: e.target.value }))
                }
                required
                placeholder="e.g., English"
                className="mt-1 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="code" className="text-xs">
                Language Code
              </Label>
              <Input
                id="code"
                value={currentFormData.code || ""}
                onChange={(e) =>
                  setCurrentFormData((p) => ({ ...p, code: e.target.value }))
                }
                required
                placeholder="e.g., en, bn"
                className="mt-1 text-sm"
              />
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <Switch
                id="isActive"
                checked={currentFormData.isActive}
                onCheckedChange={(checked) =>
                  setCurrentFormData((p) => ({ ...p, isActive: checked }))
                }
              />
              <Label htmlFor="isActive" className="text-xs font-normal">
                Set as Active Language
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <Switch
                id="isDefault"
                checked={currentFormData.isDefault}
                onCheckedChange={(checked) =>
                  setCurrentFormData((p) => ({ ...p, isDefault: checked }))
                }
              />
              <Label htmlFor="isDefault" className="text-xs font-normal">
                Set as Default (Fallback)
              </Label>
            </div>
          </div>

          <Tabs defaultValue="labels" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="labels">Field Labels</TabsTrigger>
              <TabsTrigger value="messages">Messages & Text</TabsTrigger>
              <TabsTrigger value="visibility">Field Visibility</TabsTrigger>
            </TabsList>

            <TabsContent value="labels" className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                {[
                  ["customerNameLabel", "Customer Name Label"],
                  ["customerNamePlaceholder", "Customer Name Placeholder"],
                  ["customerPhoneLabel", "Phone Label"],
                  ["customerPhonePlaceholder", "Phone Placeholder"],
                  ["customerPhoneHelp", "Phone Help Text"],
                  ["customerEmailLabel", "Email Label"],
                  ["customerEmailPlaceholder", "Email Placeholder"],
                  ["shippingAddressLabel", "Address Label"],
                  ["shippingAddressPlaceholder", "Address Placeholder"],
                  ["cityLabel", "City Label"],
                  ["zoneLabel", "Zone Label"],
                  ["areaLabel", "Area Label"],
                ].map(([key, label]) => (
                  <div key={key}>
                    <Label className="text-xs">{label}</Label>
                    <Input
                      value={currentFormData.languageData?.[key] || ""}
                      onChange={(e) => updateLanguageData(key, e.target.value)}
                      className="mt-1 text-sm"
                    />
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="messages" className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                {[
                  ["pageTitle", "Page Title"],
                  ["checkoutSectionTitle", "Checkout Section Title"],
                  ["placeOrderText", "Place Order Button"],
                  ["processingText", "Processing Text"],
                ].map(([key, label]) => (
                  <div key={key}>
                    <Label className="text-xs">{label}</Label>
                    <Input
                      value={currentFormData.languageData?.[key] || ""}
                      onChange={(e) => updateLanguageData(key, e.target.value)}
                      className="mt-1 text-sm"
                    />
                  </div>
                ))}
                <div className="col-span-2">
                  <Label className="text-xs">Terms & Conditions Text</Label>
                  <Textarea
                    value={currentFormData.languageData?.termsText || ""}
                    onChange={(e) =>
                      updateLanguageData("termsText", e.target.value)
                    }
                    className="mt-1 text-sm"
                    rows={2}
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="visibility" className="space-y-4 mt-4">
              <div className="space-y-4">
                {[
                  ["showEmailField", "Show Email Field"],
                  ["showOrderNotesField", "Show Order Notes Field"],
                  ["showAreaField", "Show Area Field (Optional)"],
                ].map(([key, label]) => (
                  <div key={key} className="flex items-center space-x-2">
                    <Switch
                      id={key}
                      checked={currentFormData.fieldVisibility?.[key] ?? true}
                      onCheckedChange={(checked) =>
                        updateFieldVisibility(key, checked)
                      }
                    />
                    <Label htmlFor={key} className="text-xs font-normal">
                      {label}
                    </Label>
                  </div>
                ))}
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter className="pt-4">
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs h-8"
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={isActionLoading}
              size="sm"
              className="text-xs h-8"
            >
              {isActionLoading && (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              )}{" "}
              {editingLanguage ? "Save Changes" : "Create Language"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function getInitialFormData(
  lang: ManagerCheckoutLanguage | null,
): Partial<ManagerCheckoutLanguage> {
  if (!lang) {
    return {
      name: "",
      code: "",
      isActive: false,
      isDefault: false,
      languageData: { ...defaultLanguageData },
      fieldVisibility: { ...defaultFieldVisibility },
    };
  }
  return {
    ...lang,
    languageData: {
      ...defaultLanguageData,
      ...(lang.languageData || {}),
    },
    fieldVisibility: {
      ...defaultFieldVisibility,
      ...(lang.fieldVisibility || {}),
    },
  };
}
