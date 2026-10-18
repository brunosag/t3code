import type { ProviderOptionChoice, ProviderOptionSelection } from "@t3tools/contracts";
import { isClaudeCompactionOption } from "@t3tools/shared/claudeCompaction";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { composerFloatingLayerProps } from "./composerEventScope";

export interface ClaudeCompactionControlsProps {
  options: ReadonlyArray<ProviderOptionSelection> | undefined;
  thresholds: ReadonlyArray<ProviderOptionChoice>;
  disabled: boolean;
  onChange: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
}

export function ClaudeCompactionControls({
  options,
  thresholds,
  disabled,
  onChange,
}: ClaudeCompactionControlsProps) {
  const mode = getProviderOptionStringSelectionValue(options, "autoCompact") ?? "default";
  const threshold =
    getProviderOptionStringSelectionValue(options, "autoCompactWindow") ?? "default";
  const customized = mode !== "default" || threshold !== "default";
  const change = (id: string, value: string) => {
    onChange([...(options ?? []).filter((option) => option.id !== id), { id, value }]);
  };

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border/50 pt-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>Auto-compact</span>
        <div className="flex items-center gap-2">
          {mode === "default" ? (
            <span className="text-2xs text-secondary-label">Default</span>
          ) : null}
          <Switch
            size="sm"
            aria-label="Auto-compact"
            mixed={mode === "default"}
            checked={mode !== "off"}
            disabled={disabled}
            onCheckedChange={(checked) => change("autoCompact", checked ? "on" : "off")}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>Compact at</span>
        <Select
          value={threshold}
          disabled={disabled || mode === "off"}
          onValueChange={(value) => {
            if (value !== null) change("autoCompactWindow", value);
          }}
        >
          <SelectTrigger size="compact" variant="ghost" aria-label="Auto-compaction threshold">
            <SelectValue>
              {thresholds.find((choice) => choice.id === threshold)?.label ?? "Default"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup {...composerFloatingLayerProps} align="end" matchTriggerWidth={false}>
            {thresholds.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="flex min-h-6 items-center justify-between gap-2 text-2xs text-secondary-label">
        <span>Applies next message</span>
        {customized ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={disabled}
            aria-label="Use Claude compaction settings"
            onClick={() =>
              onChange(options?.filter((option) => !isClaudeCompactionOption(option.id)))
            }
          >
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  );
}
