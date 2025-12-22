// src/components/admin/ProductForm/variants/VariantTemplateSelector.tsx

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BookTemplate, Trash2 } from "lucide-react";
import { useVariantTemplates } from "./hooks/useVariantTemplates";
import type { VariantTemplate, ProductVariant } from "./types";

interface VariantTemplateSelectorProps {
  onApplyTemplate: (template: VariantTemplate) => void;
  onSaveAsTemplate: (variant: ProductVariant) => void;
  disabled?: boolean;
}

export function VariantTemplateSelector({
  onApplyTemplate,

  disabled,
}: VariantTemplateSelectorProps) {
  const { templates, saveTemplate, deleteTemplate } = useVariantTemplates();
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);

  // Save template form state
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  const [tempVariant, setTempVariant] = useState<ProductVariant | null>(null);

  const confirmSaveTemplate = () => {
    if (!tempVariant || !templateName.trim()) return;

    saveTemplate({
      name: templateName.trim(),
      description: templateDescription.trim() || undefined,
      size: tempVariant.size,
      color: tempVariant.color,
      weight: tempVariant.weight,
      price: tempVariant.price,
      stock: tempVariant.stock,
      discountType: tempVariant.discountType,
      discountPercentage: tempVariant.discountPercentage,
      discountAmount: tempVariant.discountAmount,
    });

    setTemplateName("");
    setTemplateDescription("");
    setTempVariant(null);
    setSaveDialogOpen(false);
  };

  const handleApplyTemplate = (templateId: string) => {
    const template = templates.find((t) => t.id === templateId);
    if (template) {
      onApplyTemplate(template);
      setLoadDialogOpen(false);
    }
  };

  const handleDeleteTemplate = (templateId: string) => {
    if (confirm("Are you sure you want to delete this template?")) {
      deleteTemplate(templateId);
    }
  };

  return (
    <>
      {/* Load Template Dialog */}
      <Dialog open={loadDialogOpen} onOpenChange={setLoadDialogOpen}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || templates.length === 0}
          >
            <BookTemplate className="mr-2 h-4 w-4" />
            Load Template
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Load Variant Template</DialogTitle>
            <DialogDescription>
              Select a saved template to quickly create a variant with
              pre-filled values.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-4">
            {templates.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <BookTemplate className="mx-auto h-12 w-12 mb-2 opacity-20" />
                <p>No templates saved yet</p>
                <p className="text-sm">
                  Create a variant and click "Save as Template" to reuse it
                  later
                </p>
              </div>
            ) : (
              templates.map((template) => (
                <Card
                  key={template.id}
                  className="cursor-pointer hover:border-primary"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <CardTitle className="text-base">
                          {template.name}
                        </CardTitle>
                        {template.description && (
                          <CardDescription className="text-sm">
                            {template.description}
                          </CardDescription>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteTemplate(template.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="pb-3">
                    <div className="flex flex-wrap gap-2 mb-3">
                      {template.size && (
                        <Badge variant="secondary">Size: {template.size}</Badge>
                      )}
                      {template.color && (
                        <Badge variant="secondary">
                          Color: {template.color}
                        </Badge>
                      )}
                      {template.weight && (
                        <Badge variant="secondary">
                          Weight: {template.weight}g
                        </Badge>
                      )}
                      <Badge variant="secondary">
                        Price: ৳{template.price}
                      </Badge>
                      <Badge variant="secondary">Stock: {template.stock}</Badge>
                    </div>
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={() => handleApplyTemplate(template.id)}
                    >
                      Use This Template
                    </Button>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Save Template Dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as Template</DialogTitle>
            <DialogDescription>
              Save this variant configuration as a template for future use.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="template-name">Template Name</Label>
              <Input
                id="template-name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="e.g., Standard T-Shirt Variant"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-description">
                Description (Optional)
              </Label>
              <Textarea
                id="template-description"
                value={templateDescription}
                onChange={(e) => setTemplateDescription(e.target.value)}
                placeholder="Brief description of when to use this template"
                rows={3}
              />
            </div>

            {tempVariant && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Template Preview</CardTitle>
                </CardHeader>
                <CardContent className="pb-3">
                  <div className="flex flex-wrap gap-2 text-sm">
                    {tempVariant.size && (
                      <Badge variant="outline">Size: {tempVariant.size}</Badge>
                    )}
                    {tempVariant.color && (
                      <Badge variant="outline">
                        Color: {tempVariant.color}
                      </Badge>
                    )}
                    {tempVariant.weight && (
                      <Badge variant="outline">
                        Weight: {tempVariant.weight}g
                      </Badge>
                    )}
                    <Badge variant="outline">Price: ৳{tempVariant.price}</Badge>
                    <Badge variant="outline">Stock: {tempVariant.stock}</Badge>
                    {tempVariant.discountPercentage && (
                      <Badge variant="outline">
                        Discount: {tempVariant.discountPercentage}%
                      </Badge>
                    )}
                    {tempVariant.discountAmount && (
                      <Badge variant="outline">
                        Discount: ৳{tempVariant.discountAmount}
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSaveDialogOpen(false);
                setTemplateName("");
                setTemplateDescription("");
                setTempVariant(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmSaveTemplate}
              disabled={!templateName.trim()}
            >
              Save Template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
