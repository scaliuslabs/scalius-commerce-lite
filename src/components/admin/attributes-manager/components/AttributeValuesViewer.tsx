// src/components/admin/attributes-manager/components/AttributeValuesViewer.tsx
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Search, Package, X } from "lucide-react";
import { toast } from "sonner";
import type { AttributeValuesViewerProps, AttributeValue } from "../types";

export function AttributeValuesViewer({
  attributeId,
  attributeName,
  onClose,
}: AttributeValuesViewerProps) {
  const [values, setValues] = useState<AttributeValue[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!attributeId) {
      setValues([]);
      setSearchQuery("");
      setIsLoading(false);
      return;
    }

    // Set loading immediately when attributeId changes
    setIsLoading(true);
    setValues([]);
    setSearchQuery("");

    const fetchValues = async () => {
      try {
        const response = await fetch(
          `/api/admin/attributes/${attributeId}/values`,
        );
        if (!response.ok) throw new Error("Failed to fetch attribute values");
        const data = await response.json();
        setValues(data.values || []);
      } catch (error) {
        console.error("Error fetching attribute values:", error);
        toast.error("Failed to load attribute values");
        setValues([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchValues();
  }, [attributeId]);

  const filteredValues = values.filter((v) =>
    v.value.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const totalProducts = values.reduce((sum, v) => sum + v.productCount, 0);

  return (
    <Dialog open={!!attributeId} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            {attributeName} - Values & Usage
          </DialogTitle>
          <DialogDescription>
            View all unique values for this attribute and the products using
            them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
          {/* Statistics */}
          <div className="flex gap-3 shrink-0">
            <div className="flex-1 p-3 border rounded-lg">
              <div className="text-sm text-muted-foreground">Unique Values</div>
              <div className="text-2xl font-bold">
                {isLoading ? "-" : values.length}
              </div>
            </div>
            <div className="flex-1 p-3 border rounded-lg">
              <div className="text-sm text-muted-foreground">
                Total Products
              </div>
              <div className="text-2xl font-bold">
                {isLoading ? "-" : totalProducts}
              </div>
            </div>
          </div>

          {/* Search */}
          <div className="relative shrink-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search values..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              disabled={isLoading}
            />
          </div>

          {/* Values Table - Fixed height container */}
          <div className="border rounded-lg overflow-hidden flex-1 min-h-0 flex flex-col">
            {isLoading ? (
              <div className="flex items-center justify-center flex-1">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : filteredValues.length > 0 ? (
              <div className="flex-1 overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-background z-10">
                    <TableRow>
                      <TableHead className="bg-muted/50">Value</TableHead>
                      <TableHead className="text-center bg-muted/50">
                        Products
                      </TableHead>
                      <TableHead className="bg-muted/50">
                        Example Products
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredValues.map((item, index) => (
                      <TableRow key={`${item.value}-${index}`}>
                        <TableCell className="font-medium">
                          {item.value}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant="secondary">{item.productCount}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {(item.productNames || [])
                              .slice(0, 3)
                              .map((name, idx) => (
                                <Badge
                                  key={idx}
                                  variant="outline"
                                  className="text-xs"
                                >
                                  {name}
                                </Badge>
                              ))}
                            {(item.productNames || []).length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{(item.productNames || []).length - 3} more
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center flex-1 text-center">
                <Package className="h-10 w-10 opacity-40 mb-2" />
                <p className="text-sm text-muted-foreground">
                  {searchQuery
                    ? "No values match your search"
                    : "No values found for this attribute"}
                </p>
              </div>
            )}
          </div>

          <div className="flex justify-end shrink-0">
            <Button variant="outline" onClick={onClose}>
              <X className="h-4 w-4 mr-2" />
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
