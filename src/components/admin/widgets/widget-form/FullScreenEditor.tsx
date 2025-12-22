/**
 * FullScreenEditor - Unified preview and improvement modal
 *
 * This component replaces both FullScreenPreview and FullScreenImprovement,
 * providing a single, powerful interface for viewing and improving widgets.
 *
 * Features:
 * - Multiple modes: generation-preview, improvement, live-preview
 * - Responsive device preview (desktop, tablet, mobile)
 * - Code view with syntax highlighting
 * - Raw output tab for error recovery
 * - Section-specific improvements (for staged widgets)
 * - Improvement history display
 * - AI context management
 */

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Laptop,
  Tablet,
  Smartphone,
  Sparkles,
  Check,
  X,
  Loader2,
  Copy,
  Code,
  ChevronRight,
  ChevronLeft,
  FileText,
  History
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { AiContextManager } from './AiContextManager';
import type { ImprovementHistoryEntry } from '@/lib/ai-context-schema';

export type EditorMode = 'generation-preview' | 'improvement' | 'live-preview';

interface Section {
  index: number;
  html: string;
  css: string;
  description?: string;
}

interface FullScreenEditorProps {
  isOpen: boolean;
  onClose: () => void;
  content: { html: string; css: string } | null;
  rawOutput?: string; // For error recovery
  onAccept: () => void;
  onImprove?: (prompt: string, targetSection?: number) => Promise<void> | Promise<boolean>;
  onRequestImprovement?: () => void; // Handler to switch from preview to improvement mode
  mode: EditorMode;
  isProcessing?: boolean;
  processingProgress?: {
    currentStage: string;
    percentage: number;
    currentSection?: number;
    totalSections?: number;
  };
  // Improvement mode props
  aiContext?: any;
  promptType?: 'widget' | 'landing-page' | 'collection';
  setPromptType?: (type: 'widget' | 'landing-page' | 'collection') => void;
  sections?: Section[];
  currentImprovementTarget?: number;
  improvementHistory?: ImprovementHistoryEntry[];
}

export const FullScreenEditor: React.FC<FullScreenEditorProps> = ({
  isOpen,
  onClose,
  content,
  rawOutput,
  onAccept,
  onImprove,
  onRequestImprovement,
  mode,
  isProcessing = false,
  processingProgress,
  aiContext,
  promptType = 'widget',
  setPromptType,
  sections = [],
  currentImprovementTarget,
  improvementHistory = [],
}) => {
  const [previewWidth, setPreviewWidth] = useState<'100%' | '768px' | '375px'>('100%');
  const [activeView, setActiveView] = useState<'preview' | 'code' | 'raw'>('preview');
  const [showPanel, setShowPanel] = useState(mode === 'improvement');
  const [improvementPrompt, setImprovementPrompt] = useState('');
  const [targetSection, setTargetSection] = useState<'all' | number>('all');
  const [showHistory, setShowHistory] = useState(false);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      setImprovementPrompt('');
      setTargetSection('all');
      setActiveView('preview');
    } else {
      setShowPanel(mode === 'improvement');
    }
  }, [isOpen, mode]);

  if (!isOpen) return null;

  const handleImprove = async () => {
    if (!improvementPrompt.trim()) {
      toast.error('Please enter improvement instructions');
      return;
    }

    if (!onImprove) {
      toast.error('Improvement function not provided');
      return;
    }

    const sectionToImprove = targetSection === 'all' ? undefined : targetSection;
    await onImprove(improvementPrompt, sectionToImprove);
    // Don't clear prompt to allow iterative improvements
  };

  const handleCopyCode = () => {
    if (!content) return;
    const code = `<!-- HTML -->\n${content.html}\n\n/* CSS */\n${content.css}`;
    navigator.clipboard.writeText(code);
    toast.success('Code copied to clipboard!');
  };

  const handleCopyRaw = () => {
    if (!rawOutput) return;
    navigator.clipboard.writeText(rawOutput);
    toast.success('Raw output copied to clipboard!');
  };

  const modeLabels = {
    'generation-preview': 'Widget Preview',
    'improvement': 'Improvement Editor',
    'live-preview': 'Live Preview',
  };

  return (
    <div className="fixed inset-0 bg-background z-[100] flex flex-col">
      {/* Header */}
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <h2 className="text-xl font-semibold">{modeLabels[mode]}</h2>
            {isProcessing && processingProgress && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{processingProgress.currentStage}</span>
                {processingProgress.currentSection !== undefined && processingProgress.totalSections && (
                  <span className="font-mono">
                    Section {processingProgress.currentSection + 1}/{processingProgress.totalSections}
                  </span>
                )}
                <span className="font-mono">{processingProgress.percentage}%</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Device Toggles */}
            {!isProcessing && activeView === 'preview' && (
              <div className="flex items-center gap-1 mr-4">
                <Button
                  size="sm"
                  variant={previewWidth === '100%' ? 'default' : 'ghost'}
                  onClick={() => setPreviewWidth('100%')}
                >
                  <Laptop className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant={previewWidth === '768px' ? 'default' : 'ghost'}
                  onClick={() => setPreviewWidth('768px')}
                >
                  <Tablet className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant={previewWidth === '375px' ? 'default' : 'ghost'}
                  onClick={() => setPreviewWidth('375px')}
                >
                  <Smartphone className="h-4 w-4" />
                </Button>
              </div>
            )}

            {/* View Toggles */}
            {!isProcessing && content && (
              <>
                {mode === 'improvement' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowPanel(!showPanel)}
                  >
                    {showPanel ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={activeView === 'preview' ? 'default' : 'outline'}
                  onClick={() => setActiveView('preview')}
                >
                  Preview
                </Button>
                <Button
                  size="sm"
                  variant={activeView === 'code' ? 'default' : 'outline'}
                  onClick={() => setActiveView('code')}
                >
                  <Code className="h-4 w-4 mr-2" />
                  Code
                </Button>
                {rawOutput && (
                  <Button
                    size="sm"
                    variant={activeView === 'raw' ? 'default' : 'outline'}
                    onClick={() => setActiveView('raw')}
                  >
                    <FileText className="h-4 w-4 mr-2" />
                    Raw
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={activeView === 'raw' ? handleCopyRaw : handleCopyCode}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Copy
                </Button>
              </>
            )}

            {/* Actions */}
            <div className="h-6 w-px bg-border mx-2" />
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X className="h-4 w-4 mr-2" />
              Close
            </Button>
            {!isProcessing && (
              <>
                {mode === 'generation-preview' && onRequestImprovement && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onRequestImprovement}
                  >
                    <Sparkles className="h-4 w-4 mr-2" />
                    Improve
                  </Button>
                )}
                <Button size="sm" onClick={onAccept}>
                  <Check className="h-4 w-4 mr-2" />
                  {mode === 'improvement' ? 'Accept & Close' : 'Accept'}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Progress Bar */}
        {isProcessing && processingProgress && (
          <div className="px-6 pb-4">
            <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
              <div
                className="bg-primary h-full transition-all duration-300 ease-out"
                style={{ width: `${processingProgress.percentage}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Preview/Code Area */}
        <div className="flex-1 overflow-auto bg-muted/20">
          {isProcessing && !content ? (
            <div className="h-full flex flex-col items-center justify-center gap-6">
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 rounded-full animate-ping" />
                <Loader2 className="h-16 w-16 text-primary animate-spin relative" />
              </div>
              <div className="text-center space-y-2">
                <p className="text-xl font-medium">Creating your widget...</p>
                <p className="text-sm text-muted-foreground">
                  {processingProgress?.currentStage || 'Please wait'}
                </p>
              </div>
            </div>
          ) : activeView === 'code' && content ? (
            <div className="h-full p-6 overflow-auto">
              <div className="max-w-6xl mx-auto space-y-4">
                <div className="bg-card rounded-lg border p-4">
                  <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">HTML</h3>
                  <pre className="text-sm overflow-auto bg-muted p-4 rounded">
                    <code>{content.html}</code>
                  </pre>
                </div>
                <div className="bg-card rounded-lg border p-4">
                  <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">CSS</h3>
                  <pre className="text-sm overflow-auto bg-muted p-4 rounded">
                    <code>{content.css}</code>
                  </pre>
                </div>
              </div>
            </div>
          ) : activeView === 'raw' && rawOutput ? (
            <div className="h-full p-6 overflow-auto">
              <div className="max-w-6xl mx-auto">
                <div className="bg-card rounded-lg border p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Raw AI Output</h3>
                    <p className="text-xs text-muted-foreground">
                      Use this if JSON parsing failed. You can manually fix and paste back.
                    </p>
                  </div>
                  <pre className="text-sm overflow-auto bg-muted p-4 rounded whitespace-pre-wrap">
                    <code>{rawOutput}</code>
                  </pre>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center p-8">
              <div
                className={cn(
                  'bg-white shadow-2xl rounded-lg overflow-hidden transition-all duration-300',
                  previewWidth === '100%' && 'w-full h-full',
                  previewWidth === '768px' && 'w-[768px] h-full',
                  previewWidth === '375px' && 'w-[375px] h-full'
                )}
              >
                <iframe
                  srcDoc={content ? `
                    <!DOCTYPE html>
                    <html lang="en">
                      <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <style>
                          * { box-sizing: border-box; }
                          body {
                            margin: 0;
                            padding: 0;
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                          }
                          ${content.css}
                        </style>
                      </head>
                      <body>
                        ${content.html}
                      </body>
                    </html>
                  ` : ''}
                  className="w-full h-full border-0"
                  sandbox="allow-scripts allow-same-origin"
                  title="Widget Preview"
                />
              </div>
            </div>
          )}
        </div>

        {/* Improvement Panel (only in improvement mode) */}
        {mode === 'improvement' && showPanel && (
          <div className="w-[400px] border-l bg-background overflow-y-auto">
            <div className="p-6 space-y-6">
              {/* History Toggle */}
              {improvementHistory.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowHistory(!showHistory)}
                  className="w-full"
                >
                  <History className="h-4 w-4 mr-2" />
                  {showHistory ? 'Hide' : 'Show'} History ({improvementHistory.length})
                </Button>
              )}

              {/* Improvement History */}
              {showHistory && improvementHistory.length > 0 && (
                <div className="space-y-2 max-h-48 overflow-y-auto border rounded-lg p-3 bg-muted/50">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Improvement History
                  </Label>
                  {improvementHistory.map((entry, idx) => (
                    <div key={idx} className="text-xs space-y-1 pb-2 border-b last:border-0">
                      <div className="font-medium">
                        {entry.section !== undefined ? `Section ${entry.section + 1}` : 'Whole widget'}
                        {entry.modelUsed && <span className="text-muted-foreground ml-2">• {entry.modelUsed.split('/').pop()}</span>}
                      </div>
                      <div className="text-muted-foreground">{entry.prompt}</div>
                      <div className="text-muted-foreground">
                        {new Date(entry.timestamp).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Section Selector */}
              {sections && sections.length > 0 && (
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Target Section ({sections.length} sections)</Label>
                  <Select
                    key={`section-selector-${sections.length}`} // Force re-render when sections change
                    value={String(targetSection)}
                    onValueChange={(v) => {
                      const newTarget = v === 'all' ? 'all' : Number(v);
                      console.log('Section target changed:', newTarget);
                      setTargetSection(newTarget);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select section" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Sections (Entire Widget)</SelectItem>
                      {sections.map((section) => (
                        <SelectItem key={`section-${section.index}`} value={String(section.index)}>
                          Section {section.index + 1}{section.description ? `: ${section.description}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Choose a specific section to improve, or improve the entire widget
                  </p>
                </div>
              )}

              {/* Improvement Prompt */}
              <div className="space-y-3">
                <Label htmlFor="improvement-prompt" className="text-base font-semibold">
                  Improvement Instructions
                </Label>
                <Textarea
                  id="improvement-prompt"
                  value={improvementPrompt}
                  onChange={(e) => setImprovementPrompt(e.target.value)}
                  rows={6}
                  placeholder="Describe what you want to improve...&#10;&#10;Example: Make the hero section background darker and add a gradient overlay"
                  className="resize-none"
                />
              </div>

              {/* Content Type */}
              {setPromptType && (
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Content Type</Label>
                  <RadioGroup value={promptType} onValueChange={(v: any) => setPromptType(v)} className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="widget" id="imp-widget" />
                      <Label htmlFor="imp-widget" className="font-normal cursor-pointer">Homepage Widget</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="landing-page" id="imp-landing" />
                      <Label htmlFor="imp-landing" className="font-normal cursor-pointer">Landing Page</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="collection" id="imp-collection" />
                      <Label htmlFor="imp-collection" className="font-normal cursor-pointer">Collection Page</Label>
                    </div>
                  </RadioGroup>
                </div>
              )}

              {/* AI Context */}
              {aiContext && (
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Context</Label>
                  <AiContextManager context={aiContext} variant="compact" />
                </div>
              )}

              {/* Improve Button */}
              <Button
                onClick={handleImprove}
                disabled={isProcessing || !improvementPrompt.trim()}
                className="w-full"
                size="lg"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {currentImprovementTarget !== undefined && sections.length > 0
                      ? `Improving Section ${currentImprovementTarget + 1}...`
                      : 'Improving...'}
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" />
                    Improve
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
