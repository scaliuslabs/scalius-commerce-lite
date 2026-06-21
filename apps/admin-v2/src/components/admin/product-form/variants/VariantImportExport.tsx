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
import type {
  ProductVariant,
  BulkGeneratedVariant,
  CsvImportResult,
} from "./types";

interface VariantImportExportProps {
  variants: ProductVariant[];
  onImport: (variants: BulkGeneratedVariant[]) => Promise<void>;
  disabled?: boolean;
}

export function VariantImportExport({
  variants,
  onImport,
  disabled,
}: VariantImportExportProps) {
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importResult, setImportResult] = useState<CsvImportResult | null>(
    null,
  );
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    const { variantsToCsv, downloadCsv } = await import("./utils/csvHelpers");
    const csv = variantsToCsv(variants);
    const timestamp = new Date().toISOString().split("T")[0];
    downloadCsv(csv, `options-${timestamp}.csv`);
  };

  const handleDownloadTemplate = async () => {
    const { generateCsvTemplate, downloadCsv } = await import(
      "./utils/csvHelpers"
    );
    const template = generateCsvTemplate();
    downloadCsv(template, "option-template.csv");
  };

  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const csvText = e.target?.result as string;
      const { parseCsvToVariants } = await import("./utils/csvHelpers");
      const result = parseCsvToVariants(
        csvText,
        variants.map((variant) => variant.sku),
      );
      setImportResult(result);
    };
    reader.readAsText(file);
  };

  const handleConfirmImport = async () => {
    if (!importResult || !importResult.success) return;

    setIsImporting(true);
    try {
      await onImport(importResult.variants);

      setImportDialogOpen(false);
      setImportResult(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error: unknown) {
      if (import.meta.env.DEV) console.error("Failed to import options:", error);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="contents">
      {/* Export Button */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleExport}
        disabled={disabled || variants.length === 0}
        className="h-8 w-full justify-center text-xs sm:w-auto"
      >
        <Download className="mr-2 h-4 w-4" />
        Export CSV
      </Button>

      {/* Import Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled} className="h-8 w-full justify-center text-xs sm:w-auto">
            <Upload className="mr-2 h-4 w-4" />
            Import CSV
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import Options from CSV</DialogTitle>
            <DialogDescription>
              Upload a CSV file with option data. Download the template to see
              the expected format.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid gap-2 sm:grid-cols-2">
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
                      {importResult.imported} option
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
