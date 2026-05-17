import React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Wand2,
  ChevronDown,
  Clipboard,
  ChevronsUpDown,
  Check,
  Eye,
  Headphones,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { cn } from '@scalius/shared/utils';
import { AiContextManager } from './AiContextManager';
import { useAiContext } from './useAiContext';
import { useAiGenerator } from './useAiGenerator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import type { Widget } from '@/types/api-responses';

interface AiAssistantProps {
  widget: Widget | undefined | null;
  aiContext: ReturnType<typeof useAiContext>;
  aiGenerator: ReturnType<typeof useAiGenerator>;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AiAssistant: React.FC<AiAssistantProps> = ({ aiContext, aiGenerator, isOpen, onOpenChange }) => {
  const {
    promptType,
    setPromptType,
    userPrompt,
    setUserPrompt,
    isLoadingPrompt,
    handleAiRequest,
    handleCopyPrompt,
    activeProvider,
    aiModels,
    selectedModel,
    setSelectedModel,
    isApiKeySet,
    isAiSettingsLoading,
    aiSettingsError,
    reloadAiSettings,
    modelSearchQuery,
    setModelSearchQuery,
    isModelSelectorOpen,
    setIsModelSelectorOpen,
    effectivePromptType,
    isPromptTypePlacementDerived,
  } = aiGenerator;
  const selectedModelInfo = aiModels.find((model) => model.id === selectedModel);

  const ModelSelector = (
    <Popover
      open={isModelSelectorOpen}
      onOpenChange={(open) => {
        setIsModelSelectorOpen(open);
        if (!open) setModelSearchQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={isModelSelectorOpen}
          className="w-full justify-between"
          disabled={!isApiKeySet || isAiSettingsLoading}
        >
          <span className="truncate">
            {isAiSettingsLoading
              ? 'Loading models...'
              : selectedModel
                ? selectedModelInfo?.name || selectedModel
                : 'Select a model...'}
          </span>
          {isAiSettingsLoading ? (
            <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin opacity-70" />
          ) : (
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        sideOffset={6}
        className="w-[min(max(var(--radix-popover-trigger-width),22rem),calc(100vw-2rem))] overflow-hidden p-0"
      >
        <Command>
          <CommandInput
            placeholder="Search for a model..."
            value={modelSearchQuery}
            onValueChange={setModelSearchQuery}
          />
          <CommandList className="max-h-[clamp(9rem,calc(var(--radix-popover-content-available-height)-2.75rem),20rem)]">
            <CommandEmpty>No model found.</CommandEmpty>
            <CommandGroup>
              {aiModels
                .filter((model) => {
                  const query = modelSearchQuery.trim().toLowerCase();
                  if (!query) return true;
                  return [model.name, model.id, model.provider ?? activeProvider].some((value) =>
                    value.toLowerCase().includes(query),
                  );
                })
                .map((model) => (
                  <CommandItem
                    key={model.id}
                    value={model.id}
                    onSelect={() => {
                      setSelectedModel(model.id);
                      setIsModelSelectorOpen(false);
                      setModelSearchQuery('');
                    }}
                  >
                    <Check className={cn('mr-2 h-4 w-4', selectedModel === model.id ? 'opacity-100' : 'opacity-0')} />
                    <span className="min-w-0 flex-1 truncate">{model.name}</span>
                    <div className="flex gap-1 ml-2">
                      {model.supportsVision && (
                        <span title="Supports vision (images)">
                          <Eye className="h-3.5 w-3.5 text-blue-500" />
                        </span>
                      )}
                      {model.supportsAudio && (
                        <span title="Supports audio">
                          <Headphones className="h-3.5 w-3.5 text-purple-500" />
                        </span>
                      )}
                    </div>
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );

  return (
    <Card
      onClick={() => {
        onOpenChange(!isOpen);
      }}
      className="cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden"
    >
      <div className="flex items-center justify-between p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Wand2 className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold">AI Widget Studio</h3>
            <p className="text-xs text-muted-foreground">
              Build scoped storefront sections from products, images, categories, and instructions.
            </p>
          </div>
        </div>
        <ChevronDown
          className={cn('h-5 w-5 text-muted-foreground transition-transform duration-300', isOpen && 'rotate-180')}
        />
      </div>
      {isOpen && (
        <div onClick={(e) => e.stopPropagation()} className="cursor-auto border-t p-4 space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Content goal</h4>
                <RadioGroup
                  onValueChange={(value: 'widget' | 'landing-page' | 'collection') => setPromptType(value)}
                  value={isPromptTypePlacementDerived ? effectivePromptType : promptType}
                  className="grid gap-2 sm:grid-cols-3"
                >
                  <div className="flex items-center space-x-2 rounded-md border p-2">
                    <RadioGroupItem value="widget" id="type-widget" disabled={isPromptTypePlacementDerived} />
                    <Label htmlFor="type-widget">Homepage Widget</Label>
                  </div>
                  <div className="flex items-center space-x-2 rounded-md border p-2">
                    <RadioGroupItem
                      value="landing-page"
                      id="type-landing-page"
                      disabled={isPromptTypePlacementDerived}
                    />
                    <Label htmlFor="type-landing-page">Landing Section</Label>
                  </div>
                  <div className="flex items-center space-x-2 rounded-md border p-2">
                    <RadioGroupItem value="collection" id="type-collection" disabled={isPromptTypePlacementDerived} />
                    <Label htmlFor="type-collection">Collection Section</Label>
                  </div>
                </RadioGroup>
                {isPromptTypePlacementDerived && (
                  <p className="text-xs text-muted-foreground">
                    Goal is derived from active placement so generated content matches where it will render.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="model">AI model</Label>
                {ModelSelector}
                {aiSettingsError ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                    <span>{aiSettingsError}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={reloadAiSettings}
                      disabled={isAiSettingsLoading}
                    >
                      <RefreshCw className="mr-2 h-3.5 w-3.5" />
                      Retry
                    </Button>
                  </div>
                ) : !isApiKeySet && !isAiSettingsLoading ? (
                  <p className="text-xs text-muted-foreground">
                    Configure the active provider in General Settings &gt; Widget AI.
                  </p>
                ) : null}
              </div>

              <div className="space-y-4">
                <h4 className="text-sm font-medium">Store context</h4>
                <AiContextManager
                  context={aiContext}
                  selectedModel={selectedModel}
                  supportsVision={selectedModelInfo?.supportsVision || false}
                  maxImages={selectedModelInfo?.maxImages}
                />
              </div>

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Merchant instructions</h4>
                <Textarea
                  id="userPrompt"
                  value={userPrompt}
                  onChange={(e) => setUserPrompt(e.target.value)}
                  rows={5}
                  placeholder="Example: Create a premium Eid campaign section with selected products, strong offer cards, trust badges, and one clear buy-now CTA per product."
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  onClick={handleCopyPrompt}
                  disabled={isLoadingPrompt || !userPrompt.trim()}
                  variant="outline"
                  size="lg"
                  title="Copy prompt for use in external AI chatbots (ChatGPT, Claude, etc.)"
                >
                  <Clipboard className="mr-2 h-4 w-4" /> Copy
                </Button>
                <Button
                  type="button"
                  onClick={handleAiRequest}
                  disabled={
                    isLoadingPrompt || isAiSettingsLoading || !userPrompt.trim() || !isApiKeySet || !selectedModel
                  }
                  size="lg"
                >
                  <Sparkles className="mr-2 h-4 w-4" /> Generate
                </Button>
              </div>
            </div>
            <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">Production guardrails</div>
              <div className="mt-2 space-y-1">
                <p>Uses scoped HTML, CSS, and optional local JS. Runtime wrappers isolate widget effects.</p>
                <p>Selected products provide real buy-now URLs, pricing, images, and category context.</p>
                <p>Generation, improvement, context hydration, and validation run through one API pipeline.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};
