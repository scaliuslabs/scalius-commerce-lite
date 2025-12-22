// src/components/admin/ProductForm/variants/SkuTemplateConfig.tsx

import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Info, Plus, Settings2 } from "lucide-react";
import { SKU_VARIABLES } from "./types";
import { validateSkuTemplate, getSkuExample } from "./utils/skuGenerator";

interface SkuTemplateConfigProps {
  value: string;
  onChange: (template: string) => void;
  productSlug?: string;
  className?: string;
}

export function SkuTemplateConfig({
  value,
  onChange,
  productSlug,
  className,
}: SkuTemplateConfigProps) {
  const [template, setTemplate] = useState(value);
  const [example, setExample] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Update example whenever template or product slug changes
  useEffect(() => {
    if (template) {
      const validation = validateSkuTemplate(template);
      if (validation.valid) {
        setExample(getSkuExample(template, productSlug));
        setError(null);
      } else {
        setError(validation.error || null);
        setExample("");
      }
    } else {
      setExample("");
      setError(null);
    }
  }, [template, productSlug]);

  const handleTemplateChange = (newTemplate: string) => {
    setTemplate(newTemplate);
    onChange(newTemplate);
  };

  const insertVariable = (placeholder: string) => {
    const newTemplate = template + placeholder;
    handleTemplateChange(newTemplate);
  };

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-2">
        <Label htmlFor="sku-template" className="flex items-center gap-2">
          SKU Template
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-4 w-4 p-0">
                <Info className="h-3 w-3 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80" align="start">
              <div className="space-y-2">
                <h4 className="font-medium text-sm">SKU Template Variables</h4>
                <p className="text-xs text-muted-foreground">
                  Use these variables to auto-generate SKUs for bulk variants:
                </p>
                <div className="space-y-1">
                  {SKU_VARIABLES.map((variable) => (
                    <div key={variable.name} className="text-xs">
                      <code className="bg-muted px-1 py-0.5 rounded">
                        {variable.placeholder}
                      </code>
                      <span className="text-muted-foreground ml-2">
                        e.g., {variable.example}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </Label>

        {/* Preset Selector */}
        <Select onValueChange={handleTemplateChange}>
          <SelectTrigger className="h-7 w-[130px] text-xs border-dashed">
            <Settings2 className="w-3 h-3 mr-2 opacity-70" />
            <SelectValue placeholder="Presets" />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="{SLUG}-{SIZE}-{COLOR}">
              Slug-Size-Color
            </SelectItem>
            <SelectItem value="{SLUG}-{COLOR}-{SIZE}">
              Slug-Color-Size
            </SelectItem>
            <SelectItem value="{RANDOM}-{SIZE}-{COLOR}">
              Random-Size-Color
            </SelectItem>
            <SelectItem value="SKU-{RANDOM}">Simple Random</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-3">
        <div className="flex gap-2">
          <Input
            id="sku-template"
            value={template}
            onChange={(e) => handleTemplateChange(e.target.value)}
            placeholder="{SLUG}-{SIZE}-{COLOR}"
            className="font-mono text-sm"
          />
        </div>

        <div className="flex flex-wrap gap-1">
          {SKU_VARIABLES.map((variable) => (
            <Button
              key={variable.name}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => insertVariable(variable.placeholder)}
            >
              <Plus className="h-3 w-3 mr-1" />
              {variable.name}
            </Button>
          ))}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {example && !error && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Preview:</p>
            <Badge variant="secondary" className="font-mono text-xs">
              {example}
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}
