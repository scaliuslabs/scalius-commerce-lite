
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Eye, ClipboardPaste, Sparkles } from 'lucide-react';

interface WidgetDetailsProps {
  register: any;
  errors: any;
  handleShowPreview: () => void;
  onPaste: () => void;
  onImproveExisting?: () => void; // New prop for improving existing content
}

export const WidgetDetails: React.FC<WidgetDetailsProps> = ({
  register,
  errors,
  handleShowPreview,
  onPaste,
  onImproveExisting
}) => {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Widget Details</CardTitle>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onPaste}>
              <ClipboardPaste className="mr-2 h-4 w-4" />
              Paste AI Response
          </Button>
          {onImproveExisting && (
            <Button type="button" variant="outline" size="sm" onClick={onImproveExisting}>
              <Sparkles className="mr-2 h-4 w-4" />
              Improve Existing
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={handleShowPreview}>
              <Eye className="mr-2 h-4 w-4" />
              Show Live Preview
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
        <div className="space-y-2">
          <Label htmlFor="htmlContent">HTML Content</Label>
          <Textarea
            id="htmlContent"
            {...register("htmlContent")}
            rows={10}
            placeholder="<div>Your HTML here...</div>"
          />
          {errors.htmlContent && (
            <p className="text-sm text-destructive">
              {errors.htmlContent.message}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="cssContent">CSS Content (Optional)</Label>
          <Textarea
            id="cssContent"
            {...register("cssContent")}
            rows={6}
            placeholder=".my-widget-class { color: blue; }"
          />
          {errors.cssContent && (
            <p className="text-sm text-destructive">
              {errors.cssContent.message}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
