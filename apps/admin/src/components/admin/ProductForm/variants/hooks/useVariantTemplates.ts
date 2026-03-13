// src/components/admin/ProductForm/variants/hooks/useVariantTemplates.ts

import { useState, useEffect } from "react";
import type { VariantTemplate } from "../types";

const STORAGE_KEY = "scalius_variant_templates";

export interface UseVariantTemplatesReturn {
  templates: VariantTemplate[];
  saveTemplate: (template: Omit<VariantTemplate, "id" | "createdAt">) => void;
  deleteTemplate: (id: string) => void;
  getTemplate: (id: string) => VariantTemplate | undefined;
}

export function useVariantTemplates(): UseVariantTemplatesReturn {
  const [templates, setTemplates] = useState<VariantTemplate[]>([]);

  // Load templates from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Convert date strings back to Date objects
        const templatesWithDates = parsed.map((t: any) => ({
          ...t,
          createdAt: new Date(t.createdAt),
        }));
        setTemplates(templatesWithDates);
      }
    } catch (error) {
      console.error("Failed to load variant templates:", error);
    }
  }, []);

  // Save templates to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
    } catch (error) {
      console.error("Failed to save variant templates:", error);
    }
  }, [templates]);

  const saveTemplate = (
    template: Omit<VariantTemplate, "id" | "createdAt">,
  ) => {
    const newTemplate: VariantTemplate = {
      ...template,
      id: `tpl_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      createdAt: new Date(),
    };

    setTemplates((prev) => [...prev, newTemplate]);
  };

  const deleteTemplate = (id: string) => {
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  };

  const getTemplate = (id: string): VariantTemplate | undefined => {
    return templates.find((t) => t.id === id);
  };

  return {
    templates,
    saveTemplate,
    deleteTemplate,
    getTemplate,
  };
}
