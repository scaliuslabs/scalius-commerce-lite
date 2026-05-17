import { useCallback, useState } from 'react';

export interface SectionContent {
  html: string;
  css: string;
  js?: string;
  sectionIndex: number;
  description?: string;
  id: string;
  timestamp: number;
}

interface SectionCompositionState {
  isGenerating: boolean;
  currentStage: 'idle' | 'planning' | 'generating' | 'polishing' | 'complete' | 'error';
  plan: null;
  sections: SectionContent[];
  currentSectionIndex: number;
  error: string | null;
  retryCount: number;
}

const INITIAL_STATE: SectionCompositionState = {
  isGenerating: false,
  currentStage: 'idle',
  plan: null,
  sections: [],
  currentSectionIndex: 0,
  error: null,
  retryCount: 0,
};

export function useStagedGeneration() {
  const [state, setState] = useState<SectionCompositionState>(INITIAL_STATE);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const updateSections = useCallback((updatedSections: SectionContent[]) => {
    setState((prev) => ({
      ...prev,
      sections: [...updatedSections],
      currentStage: updatedSections.length > 0 ? 'complete' : prev.currentStage,
      currentSectionIndex: Math.max(0, updatedSections.length - 1),
    }));
  }, []);

  return {
    ...state,
    reset,
    updateSections,
  };
}
