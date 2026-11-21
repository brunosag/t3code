import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isMacPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

/** Words added from the desktop spellcheck menu, with a way to take each back out. */
export function SpellCheckDictionarySettings() {
  const searchableSetting = useSearchableSetting();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.spellCheck;
  const [words, setWords] = useState<readonly string[] | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads Electron's dictionary on mount
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.listWords().then(
      (next) => {
        if (!cancelled) setWords(next);
      },
      () => {
        if (!cancelled) setWords([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // macOS uses the system spellchecker, whose learned words Electron can't list.
  if (!bridge || isMacPlatform(navigator.platform)) return null;

  const remove = (word: string) => {
    setWords((current) => current?.filter((candidate) => candidate !== word) ?? null);
    void bridge
      .removeWord(word)
      .then(bridge.listWords)
      .then(setWords, () => undefined);
  };

  return (
    <SettingsRow
      {...searchableSetting("spell-check-dictionary")}
      description="Words added with Add to Dictionary in the spelling menu."
    >
      <div className="flex flex-wrap gap-1.5 pt-3 pb-2">
        {words === null ? null : words.length === 0 ? (
          <p className="text-xs text-muted-foreground">No words yet.</p>
        ) : (
          words.map((word) => (
            <span
              key={word}
              className="inline-flex items-center gap-0.5 rounded-md border bg-muted/40 py-0.5 ps-2 pe-0.5 text-xs"
            >
              {word}
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Remove ${word}`}
                onClick={() => remove(word)}
              >
                <XIcon />
              </Button>
            </span>
          ))
        )}
      </div>
    </SettingsRow>
  );
}
