// src/components/admin/ProductForm/variants/VariantImportExport.tsx

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Download,
  Upload,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import {
  variantsToCsv,
  downloadCsv,
  parseCsvToVariants,
  generateCsvTemplate,
} from "./utils/csvHelpers";
import type {
  ProductVariant,
  BulkGeneratedVariant,
  CsvImportResult,
} from "./types";

interface VariantImportExportProps {
  variants: ProductVariant[];
  existingSkus: string[];
  onImport: (variants: BulkGeneratedVariant[]) => Promise<void>;
  disabled?: boolean;
}

export function VariantImportExport({
  variants,
  // existingSkus,
  onImport,
  disabled,
}: VariantImportExportProps) {
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importResult, setImportResult] = useState<CsvImportResult | null>(
    null,
  );
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const csv = variantsToCsv(variants);
    const timestamp = new Date().toISOString().split("T")[0];
    downloadCsv(csv, `variants-${timestamp}.csv`);
  };

  const handleDownloadTemplate = () => {
    const template = generateCsvTemplate();
    downloadCsv(template, "variant-template.csv");
  };

  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const csvText = e.target?.result as string;
      const result = parseCsvToVariants(csvText);
      setImportResult(result);
    };
    reader.readAsText(file);
  };

  const handleConfirmImport = async () => {
    if (!importResult || !importResult.success) return;

    setIsImporting(true);
    try {
      // Convert CSV rows to BulkGeneratedVariant format
      const csvLines = (fileInputRef.current?.files?.[0] as File)
        .text()
        .then((text) => {
          const lines = text.trim().split("\n").slice(1); // Skip header
          const variants: BulkGeneratedVariant[] = [];

          for (const line of lines) {
            const values = parseCsvLine(line);
            if (values.length < 6) continue;

            const [
              sku,
              size,
              color,
              weightStr,
              priceStr,
              stockStr,
              discountType,
              discountValueStr,
            ] = values;

            const price = parseFloat(priceStr);
            const stock = parseInt(stockStr, 10);
            const weight =
              weightStr && weightStr.trim() ? parseFloat(weightStr) : null;
            const parsedDiscountType =
              discountType?.trim().toLowerCase() === "flat"
                ? "flat"
                : "percentage";
            const discountValue =
              discountValueStr && discountValueStr.trim()
                ? parseFloat(discountValueStr)
                : null;

            variants.push({
              sku: sku.trim(),
              size: size?.trim() || null,
              color: color?.trim() || null,
              weight,
              price,
              stock,
              discountType: parsedDiscountType,
              discountPercentage:
                parsedDiscountType === "percentage" ? discountValue : null,
              discountAmount:
                parsedDiscountType === "flat" ? discountValue : null,
            });
          }

          return variants;
        });

      const variantsToImport = await csvLines;
      await onImport(variantsToImport);

      setImportDialogOpen(false);
      setImportResult(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      console.error("Failed to import variants:", error);
    } finally {
      setIsImporting(false);
    }
  };

  function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    result.push(current);
    return result;
  }

  return (
    <div className="flex gap-2">
      {/* Export Button */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleExport}
        disabled={disabled || variants.length === 0}
      >
        <Download className="mr-2 h-4 w-4" />
        Export CSV
      </Button>

      {/* Import Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled}>
            <Upload className="mr-2 h-4 w-4" />
            Import CSV
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import Variants from CSV</DialogTitle>
            <DialogDescription>
              Upload a CSV file with variant data. Download the template to see
              the expected format.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadTemplate}
                className="flex-1"
              >
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                Download Template
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="flex-1"
              >
                <Upload className="mr-2 h-4 w-4" />
                Select CSV File
              </Button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileSelect}
              className="hidden"
            />

            {importResult && (
              <div className="space-y-3">
                {importResult.success ? (
                  <Alert>
                    <CheckCircle2 className="h-4 w-4" />
                    <AlertTitle>Ready to Import</AlertTitle>
                    <AlertDescription>
                      {importResult.imported} variant
                      {importResult.imported !== 1 ? "s" : ""} will be imported.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Import Errors</AlertTitle>
                    <AlertDescription>
                      {importResult.failed} row
                      {importResult.failed !== 1 ? "s" : ""} failed validation.
                      Please fix the errors and try again.
                    </AlertDescription>
                  </Alert>
                )}

                {importResult.errors.length > 0 && (
                  <div className="border rounded-md p-3 max-h-[200px] overflow-y-auto">
                    <p className="text-sm font-medium mb-2">Errors:</p>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {importResult.errors.slice(0, 10).map((error, index) => (
                        <li key={index}>
                          Row {error.row}: {error.error}
                        </li>
                      ))}
                      {importResult.errors.length > 10 && (
                        <li className="text-xs italic">
                          ... and {importResult.errors.length - 10} more error
                          {importResult.errors.length - 10 !== 1 ? "s" : ""}
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setImportDialogOpen(false);
                setImportResult(null);
                if (fileInputRef.current) {
                  fileInputRef.current.value = "";
                }
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmImport}
              disabled={!importResult || !importResult.success || isImporting}
            >
              {isImporting ? "Importing..." : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
