
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@scalius/shared/utils';
import { Eye, ClipboardPaste, Sparkles, Code2, ChevronDown } from 'lucide-react';
import type { UseFormRegister, UseFormWatch, FieldErrors } from 'react-hook-form';
import type { WidgetFormValues } from '@/lib/form-schemas';

interface WidgetDetailsProps {
  register: UseFormRegister<WidgetFormValues>;
  watch: UseFormWatch<WidgetFormValues>;
  errors: FieldErrors<WidgetFormValues>;
  handleShowPreview: () => void;
  onPaste: () => void;
  onImproveExisting?: () => void; // New prop for improving existing content
}

export const WidgetDetails: React.FC<WidgetDetailsProps> = ({
  register,
  watch,
  errors,
  handleShowPreview,
  onPaste,
  onImproveExisting
}) => {
  const [isCodeOpen, setIsCodeOpen] = React.useState(false);
  const html = watch("htmlContent") || "";
  const css = watch("cssContent") || "";
  const js = watch("jsContent") || "";
  const hasContent = html.trim().length > 0;

  React.useEffect(() => {
    if (errors.htmlContent || errors.cssContent) {
      setIsCodeOpen(true);
    }
  }, [errors.htmlContent, errors.cssContent]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 p-4">
        <div>
          <CardTitle className="text-base">Widget content</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {hasContent
              ? `${html.length.toLocaleString()} HTML, ${css.length.toLocaleString()} CSS, ${js.length.toLocaleString()} JS chars`
              : "Generate, paste, or write a widget artifact."}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onPaste}>
              <ClipboardPaste className="mr-2 h-4 w-4" />
              Paste
          </Button>
          {onImproveExisting && (
            <Button type="button" variant="outline" size="sm" onClick={onImproveExisting}>
              <Sparkles className="mr-2 h-4 w-4" />
              Improve
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={handleShowPreview}>
              <Eye className="mr-2 h-4 w-4" />
              Preview
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Widget Name</Label>
          <Input
            id="name"
            {...register("name")}
            placeholder="e.g., Homepage Promo Banner"
          />
          {errors.name && (
            <p className="text-sm text-destructive">
              {errors.name.message}
            </p>
          )}
        </div>
        <Collapsible open={isCodeOpen} onOpenChange={setIsCodeOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" className="w-full justify-between">
              <span className="inline-flex items-center gap-2">
                <Code2 className="h-4 w-4" />
                Advanced Code
              </span>
              <ChevronDown className={cn("h-4 w-4 transition-transform", isCodeOpen && "rotate-180")} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="htmlContent">HTML</Label>
              <Textarea
                id="htmlContent"
                {...register("htmlContent")}
                rows={10}
                placeholder="<div>Your HTML here...</div>"
                className="font-mono text-xs"
              />
              {errors.htmlContent && (
                <p className="text-sm text-destructive">
                  {errors.htmlContent.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="cssContent">CSS</Label>
              <Textarea
                id="cssContent"
                {...register("cssContent")}
                rows={6}
                placeholder=".my-widget-class { color: blue; }"
                className="font-mono text-xs"
              />
              {errors.cssContent && (
                <p className="text-sm text-destructive">
                  {errors.cssContent.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="jsContent">JS</Label>
              <Textarea
                id="jsContent"
                {...register("jsContent")}
                rows={6}
                placeholder="/* Optional. Use widget.root, widget.query(), or widget.queryAll(). */"
                className="font-mono text-xs"
              />
              {errors.jsContent && (
                <p className="text-sm text-destructive">
                  {errors.jsContent.message}
                </p>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
};
