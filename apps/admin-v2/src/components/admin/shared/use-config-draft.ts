import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Keeps a settings editor draft separate from the last saved snapshot.
 * Incoming query refreshes are adopted only while the merchant has no local
 * changes, so background revalidation cannot silently erase form input.
 */
export function useConfigDraft<T>(initialConfig: T): {
  config: T;
  setConfig: Dispatch<SetStateAction<T>>;
  isDirty: boolean;
  discard: () => void;
  markSaved: () => void;
} {
  const incomingKey = useMemo(
    () => JSON.stringify(initialConfig),
    [initialConfig],
  );
  const incomingKeyRef = useRef(incomingKey);
  const [config, setConfig] = useState<T>(() => cloneConfig(initialConfig));
  const [savedConfig, setSavedConfig] = useState<T>(() =>
    cloneConfig(initialConfig),
  );
  const isDirty = JSON.stringify(config) !== JSON.stringify(savedConfig);

  useEffect(() => {
    if (incomingKeyRef.current === incomingKey) return;
    incomingKeyRef.current = incomingKey;
    if (!isDirty) {
      const next = cloneConfig(initialConfig);
      setConfig(next);
      setSavedConfig(cloneConfig(next));
    }
  }, [incomingKey, initialConfig, isDirty]);

  useEffect(() => {
    if (!isDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [isDirty]);

  const discard = useCallback(() => {
    setConfig(cloneConfig(savedConfig));
  }, [savedConfig]);

  const markSaved = useCallback(() => {
    setSavedConfig(cloneConfig(config));
  }, [config]);

  return { config, setConfig, isDirty, discard, markSaved };
}
