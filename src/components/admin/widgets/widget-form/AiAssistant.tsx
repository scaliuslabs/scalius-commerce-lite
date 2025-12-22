
import React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Wand2, ChevronDown, Clipboard, ChevronsUpDown, Check, Eye, Headphones, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AiContextManager } from './AiContextManager';
import { useAiContext } from './useAiContext';
import { useAiGenerator } from './useAiGenerator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';

interface AiAssistantProps {
  widget: any;
  aiContext: ReturnType<typeof useAiContext>;
  aiGenerator: ReturnType<typeof useAiGenerator>;
}

export const AiAssistant: React.FC<AiAssistantProps> = ({ aiContext, aiGenerator }) => {
  const [isAiHelperOpen, setIsAiHelperOpen] = React.useState(false);

  const {
    promptType,
    setPromptType,
    userPrompt,
    setUserPrompt,
    isLoadingPrompt,
    handleAiRequest,
    handleCopyPrompt,
    openRouterModels,
    selectedModel,
    setSelectedModel,
    isApiKeySet,
    modelSearchQuery,
    setModelSearchQuery,
    isModelSelectorOpen,
    setIsModelSelectorOpen,
    useStagedMode,
    setUseStagedMode,
    stagedGeneration,
  } = aiGenerator;

  const ModelSelector = (
    <Popover open={isModelSelectorOpen} onOpenChange={setIsModelSelectorOpen}>
        <PopoverTrigger asChild>
            <Button
                variant="outline"
                role="combobox"
                aria-expanded={isModelSelectorOpen}
                className="w-full justify-between"
                disabled={!isApiKeySet}
            >
                <span className="truncate">
                {selectedModel
                    ? openRouterModels.find((model) => model.id === selectedModel)?.name
                    : "Select a model..."}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
            <Command>
                <CommandInput
                    placeholder="Search for a model..."
                    value={modelSearchQuery}
                    onValueChange={setModelSearchQuery}
                />
                <CommandList>
                    <CommandEmpty>No model found.</CommandEmpty>
                    <CommandGroup>
                        {openRouterModels
                            .filter(model => model.name.toLowerCase().includes(modelSearchQuery.toLowerCase()))
                            .map((model) => (
                                <CommandItem
                                    key={model.id}
                                    value={model.id}
                                    onSelect={(currentValue) => {
                                        const newModelId = currentValue === selectedModel ? "" : model.id;
                                        setSelectedModel(newModelId);
                                        // Save globally for next widget creation + save to widget's aiContext on form submission
                                        localStorage.setItem('global_preferred_ai_model', newModelId);
                                        setIsModelSelectorOpen(false);
                                        setModelSearchQuery("");
                                    }}
                                >
                                    <Check
                                        className={cn(
                                            "mr-2 h-4 w-4",
                                            selectedModel === model.id ? "opacity-100" : "opacity-0"
                                        )}
                                    />
                                    <span className="flex-1">{model.name}</span>
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
        setIsAiHelperOpen(!isAiHelperOpen);
      }}
      className="cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden"
    >
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Wand2 className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">AI Content Assistant</h3>
            <p className="text-sm text-muted-foreground">
              Generate new HTML and CSS for widgets, pages, and collections.
            </p>
          </div>
        </div>
        <ChevronDown
          className={cn(
            "h-5 w-5 text-muted-foreground transition-transform duration-300",
            isAiHelperOpen && "rotate-180",
          )}
        />
      </div>
      {isAiHelperOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="cursor-auto border-t p-6 space-y-6"
        >
          <div className="space-y-2">
            <h4 className="font-medium">1. Choose Content Type</h4>
            <RadioGroup
              onValueChange={(
                value: "widget" | "landing-page" | "collection",
              ) => setPromptType(value)}
              value={promptType}
              className="flex flex-wrap gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="widget" id="type-widget" />
                <Label htmlFor="type-widget">Homepage Widget</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem
                  value="landing-page"
                  id="type-landing-page"
                />
                <Label htmlFor="type-landing-page">Landing Page</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="collection" id="type-collection" />
                <Label htmlFor="type-collection">Collection Page</Label>
              </div>
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label htmlFor="model">Select AI Model</Label>
            {ModelSelector}
            {!isApiKeySet && <p className="text-xs text-muted-foreground">Please configure your OpenRouter API key in the widget list page settings.</p>}
          </div>

          <div className="flex items-center justify-between space-x-2 rounded-md border p-3">
            <div className="flex items-center space-x-3">
              <Layers className="h-5 w-5 text-muted-foreground" />
              <div className="space-y-0.5">
                <Label htmlFor="staged-mode" className="text-sm font-medium cursor-pointer">
                  Staged Generation
                </Label>
                <p className="text-xs text-muted-foreground">
                  Generate complex widgets in sections with progressive rendering
                </p>
              </div>
            </div>
            <Switch
              id="staged-mode"
              checked={useStagedMode}
              onCheckedChange={setUseStagedMode}
              disabled={!isApiKeySet}
            />
          </div>

          {stagedGeneration.isGenerating && stagedGeneration.plan && (
            <div className="rounded-md bg-muted p-3 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">
                  {stagedGeneration.currentStage === 'planning' ? 'Planning...' : `Generating Section ${stagedGeneration.currentSectionIndex + 1} of ${stagedGeneration.plan.totalSections}`}
                </span>
                <span className="text-muted-foreground">
                  {Math.round(((stagedGeneration.currentSectionIndex + 1) / stagedGeneration.plan.totalSections) * 100)}%
                </span>
              </div>
              <div className="w-full bg-background rounded-full h-2 overflow-hidden">
                <div
                  className="bg-primary h-full transition-all duration-300"
                  style={{ width: `${((stagedGeneration.currentSectionIndex + 1) / stagedGeneration.plan.totalSections) * 100}%` }}
                />
              </div>
              {stagedGeneration.plan.sectionDescriptions && (
                <div className="text-xs text-muted-foreground space-y-1 pt-1">
                  {stagedGeneration.plan.sectionDescriptions.map((desc, i) => (
                    <div key={i} className={cn(
                      "flex items-center gap-2",
                      i < stagedGeneration.currentSectionIndex && "text-primary",
                      i === stagedGeneration.currentSectionIndex && "font-medium"
                    )}>
                      <span className={cn(
                        "w-4 h-4 rounded-full border flex items-center justify-center text-[10px]",
                        i < stagedGeneration.currentSectionIndex && "bg-primary text-primary-foreground border-primary",
                        i === stagedGeneration.currentSectionIndex && "border-primary"
                      )}>
                        {i < stagedGeneration.currentSectionIndex ? '✓' : i + 1}
                      </span>
                      <span>{desc}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-4">
            <h4 className="font-medium">2. Add Context (Optional)</h4>
            <AiContextManager
              context={aiContext}
              selectedModel={selectedModel}
              supportsVision={openRouterModels.find(m => m.id === selectedModel)?.supportsVision || false}
            />
          </div>

          <div className="space-y-2">
            <h4 className="font-medium">3. Describe Your Request</h4>
            <Textarea
              id="userPrompt"
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              rows={6}
              placeholder="Example: A hero banner with a countdown to our summer sale..."
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
                  <Clipboard className="mr-2 h-4 w-4" /> Copy Prompt
              </Button>
              <Button
                  type="button"
                  onClick={handleAiRequest}
                  disabled={isLoadingPrompt || !userPrompt.trim() || !isApiKeySet}
                  size="lg"
              >
                  <Wand2 className="mr-2 h-4 w-4" /> Generate with AI
              </Button>
          </div>
        </div>
      )}
    </Card>
  );
};
