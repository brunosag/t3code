import { PlusIcon, Trash2Icon } from "lucide-react";
import * as Equal from "effect/Equal";
import { useState } from "react";
import type { AgentDefinition } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** How `boolean | string[]` inherit fields (extensions, skills) are edited. */
type AgentNamesMode = "unset" | "all" | "none" | "custom";

const AGENT_NAMES_MODE_LABELS: Record<AgentNamesMode, string> = {
  unset: "Inherit",
  all: "All",
  none: "None",
  custom: "Only…",
};

type AgentPromptMode = "unset" | "replace" | "append" | "auto";

const AGENT_PROMPT_MODE_LABELS: Record<AgentPromptMode, string> = {
  unset: "Default",
  replace: "Replace",
  append: "Append",
  auto: "Auto",
};

/**
 * Local edit shape. Every field is a plain string so a freshly added agent can
 * sit in the draft with blank name and system prompt until both are filled in.
 * `id` is a stable render key; it never reaches the server.
 */
interface AgentDraft {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly model: string;
  readonly thinking: string;
  readonly tools: string;
  readonly extensionsMode: AgentNamesMode;
  readonly extensionsList: string;
  readonly skillsMode: AgentNamesMode;
  readonly skillsList: string;
  readonly maxTurns: string;
  readonly promptMode: AgentPromptMode;
  readonly enabled: boolean;
}

/** Split a comma-separated draft field into the trimmed names it lists. */
function parseNames(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function toNamesMode(value: boolean | readonly string[] | undefined): AgentNamesMode {
  if (value === undefined) return "unset";
  if (value === true) return "all";
  if (value === false) return "none";
  return "custom";
}

function toNamesList(value: boolean | readonly string[] | undefined): string {
  return value === undefined || typeof value === "boolean" ? "" : value.join(", ");
}

/**
 * Reverse of {@link toNamesMode}. `unset` omits the field, leaving it to a
 * same-named Pi agent file and then to the loader default.
 */
function fromNamesMode(mode: AgentNamesMode, list: string): boolean | string[] | undefined {
  if (mode === "unset") return undefined;
  if (mode === "all") return true;
  if (mode === "none") return false;
  // Nothing named yet: stay unset rather than narrowing the set to nothing.
  const names = parseNames(list);
  return names.length > 0 ? names : undefined;
}

let agentDraftId = 0;
const nextAgentDraftId = () => `agent-draft-${agentDraftId++}`;

function toDraft(definition: AgentDefinition, id: string): AgentDraft {
  return {
    id,
    name: definition.name,
    displayName: definition.displayName ?? "",
    description: definition.description ?? "",
    systemPrompt: definition.systemPrompt,
    model: definition.model ?? "",
    thinking: definition.thinking ?? "",
    tools: (definition.tools ?? []).join(", "),
    extensionsMode: toNamesMode(definition.extensions),
    extensionsList: toNamesList(definition.extensions),
    skillsMode: toNamesMode(definition.skills),
    skillsList: toNamesList(definition.skills),
    maxTurns: definition.maxTurns === undefined ? "" : String(definition.maxTurns),
    promptMode: definition.promptMode ?? "unset",
    enabled: definition.enabled,
  };
}

/** Trim the draft and drop fields left empty so the stored definition stays compact. */
function toDefinition(draft: AgentDraft): AgentDefinition {
  const tools = draft.tools
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  const displayName = draft.displayName.trim();
  const description = draft.description.trim();
  const model = draft.model.trim();
  const thinking = draft.thinking.trim();
  const extensions = fromNamesMode(draft.extensionsMode, draft.extensionsList);
  const skills = fromNamesMode(draft.skillsMode, draft.skillsList);
  const maxTurns = draft.maxTurns.trim();
  const parsedMaxTurns = /^\d+$/.test(maxTurns) ? Number(maxTurns) : undefined;
  return {
    name: draft.name.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    enabled: draft.enabled,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(parsedMaxTurns !== undefined ? { maxTurns: parsedMaxTurns } : {}),
    ...(draft.promptMode !== "unset" ? { promptMode: draft.promptMode } : {}),
  };
}

function isComplete(draft: AgentDraft): boolean {
  return draft.name.trim().length > 0 && draft.systemPrompt.trim().length > 0;
}

/** Roster keys must stay unique; fall back to `agent-2`, `agent-3`, … when `agent` is taken. */
function nextAgentName(definitions: readonly AgentDraft[]): string {
  const taken = new Set(definitions.map((definition) => definition.name.trim()));
  if (!taken.has("agent")) return "agent";
  let suffix = 2;
  while (taken.has(`agent-${suffix}`)) suffix += 1;
  return `agent-${suffix}`;
}

/**
 * Extensions and skills share a shape: inherit, all, none, or an explicit list.
 * `Only…` reveals the comma-separated list below the picker.
 */
function AgentNamesField({
  label,
  mode,
  list,
  placeholder,
  onModeChange,
  onListChange,
  onCommit,
}: {
  readonly label: string;
  readonly mode: AgentNamesMode;
  readonly list: string;
  readonly placeholder: string;
  readonly onModeChange: (mode: AgentNamesMode) => void;
  readonly onListChange: (list: string) => void;
  readonly onCommit: () => void;
}) {
  return (
    <div className="block space-y-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Select value={mode} onValueChange={(value) => onModeChange(value as AgentNamesMode)}>
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue>{AGENT_NAMES_MODE_LABELS[mode]}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          <SelectItem value="unset">Inherit</SelectItem>
          <SelectItem value="all">All</SelectItem>
          <SelectItem value="none">None</SelectItem>
          <SelectItem value="custom">Only…</SelectItem>
        </SelectPopup>
      </Select>
      {mode === "custom" ? (
        <Input
          value={list}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={`${label} names`}
          onChange={(event) => onListChange(event.target.value)}
          onBlur={onCommit}
        />
      ) : null}
    </div>
  );
}

function AgentCard({
  definition,
  index,
  onChange,
  onCommit,
  onCommitPatch,
  onToggle,
  onRemove,
}: {
  readonly definition: AgentDraft;
  readonly index: number;
  readonly onChange: (patch: Partial<AgentDraft>) => void;
  readonly onCommit: () => void;
  /** Selects persist the moment they change, so they commit a patch directly. */
  readonly onCommitPatch: (patch: Partial<AgentDraft>) => void;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemove: () => void;
}) {
  const label = definition.displayName.trim() || definition.name.trim() || `Agent ${index + 1}`;
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <label className="block min-w-0 flex-1 space-y-1.5 text-sm">
          <span className="text-muted-foreground">Name</span>
          <Input
            value={definition.name}
            spellCheck={false}
            placeholder="agent"
            onChange={(event) => onChange({ name: event.target.value })}
            onBlur={onCommit}
          />
        </label>
        <div className="flex shrink-0 items-center gap-2 pt-6">
          <Switch
            size="sm"
            checked={definition.enabled}
            aria-label={`Enable ${label}`}
            onCheckedChange={onToggle}
          />
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Remove ${label}`}
            onClick={onRemove}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm">
          <span className="text-muted-foreground">Description</span>
          <Input
            value={definition.description}
            spellCheck={false}
            placeholder="When to use this subagent"
            onChange={(event) => onChange({ description: event.target.value })}
            onBlur={onCommit}
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="text-muted-foreground">Model</span>
          <Input
            value={definition.model}
            spellCheck={false}
            placeholder="Provider default"
            onChange={(event) => onChange({ model: event.target.value })}
            onBlur={onCommit}
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="text-muted-foreground">Thinking</span>
          <Input
            value={definition.thinking}
            spellCheck={false}
            placeholder="Provider default"
            onChange={(event) => onChange({ thinking: event.target.value })}
            onBlur={onCommit}
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="text-muted-foreground">Tools</span>
          <Input
            value={definition.tools}
            spellCheck={false}
            placeholder="read, grep, ext:pi-web-access/web_search"
            onChange={(event) => onChange({ tools: event.target.value })}
            onBlur={onCommit}
          />
        </label>
        <AgentNamesField
          label="Extensions"
          mode={definition.extensionsMode}
          list={definition.extensionsList}
          placeholder="pi-web-access, librarian"
          onModeChange={(extensionsMode) => onCommitPatch({ extensionsMode })}
          onListChange={(extensionsList) => onChange({ extensionsList })}
          onCommit={onCommit}
        />
        <AgentNamesField
          label="Skills"
          mode={definition.skillsMode}
          list={definition.skillsList}
          placeholder="commit, review"
          onModeChange={(skillsMode) => onCommitPatch({ skillsMode })}
          onListChange={(skillsList) => onChange({ skillsList })}
          onCommit={onCommit}
        />
        <label className="block space-y-1.5 text-sm">
          <span className="text-muted-foreground">Max turns</span>
          <Input
            value={definition.maxTurns}
            spellCheck={false}
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="Unlimited"
            aria-label={`Max turns for ${label}`}
            onChange={(event) => onChange({ maxTurns: event.target.value })}
            onBlur={onCommit}
          />
        </label>
        <div className="block space-y-1.5 text-sm">
          <span className="text-muted-foreground">Prompt mode</span>
          <Select
            value={definition.promptMode}
            onValueChange={(value) => onCommitPatch({ promptMode: value as AgentPromptMode })}
          >
            <SelectTrigger size="sm" aria-label={`Prompt mode for ${label}`}>
              <SelectValue>{AGENT_PROMPT_MODE_LABELS[definition.promptMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem value="unset">Default</SelectItem>
              <SelectItem value="replace">Replace</SelectItem>
              <SelectItem value="append">Append</SelectItem>
              <SelectItem value="auto">Auto</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      </div>
      <label className="mt-3 block space-y-1.5 text-sm">
        <span className="text-muted-foreground">System prompt</span>
        <Textarea
          value={definition.systemPrompt}
          spellCheck={false}
          rows={4}
          placeholder="Instructions for this subagent."
          onChange={(event) => onChange({ systemPrompt: event.target.value })}
          onBlur={onCommit}
        />
      </label>
    </div>
  );
}

/**
 * T3-owned subagent definitions, scoped to one environment. Edits buffer in a
 * local draft so text fields only write on blur and a new agent with a blank
 * name or system prompt stays local until it is complete. The route keys this
 * by environment, so switching targets drops uncommitted edits.
 */
export function AgentsSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope } = useSettingsScope();
  const [draft, setDraft] = useState<AgentDraft[] | null>(null);
  const environmentWide = scope.kind === "project" || scope.kind === "checkout";

  const definitions =
    draft ?? settings.agentDefinitions.map((entry, index) => toDraft(entry, `settings-${index}`));

  const commit = (next: readonly AgentDraft[]) => {
    setDraft([...next]);
    // Hold the whole commit while any row is incomplete: writing a filtered
    // array would delete an existing agent the user is mid-edit on.
    if (!next.every(isComplete)) return;
    const persisted = next.map(toDefinition);
    // A focus/blur with no edit still fires the commit; skip the round-trip then.
    if (!Equal.equals(persisted, settings.agentDefinitions)) {
      updateSettings({ agentDefinitions: persisted });
    }
  };

  const updateAt = (index: number, patch: Partial<AgentDraft>) => {
    setDraft(definitions.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };

  const addAgent = () => {
    // A new agent is incomplete by design; the commit below holds it in the
    // draft until its name and system prompt are filled in.
    commit([
      ...definitions,
      {
        id: nextAgentDraftId(),
        name: nextAgentName(definitions),
        displayName: "",
        description: "",
        systemPrompt: "",
        model: "",
        thinking: "",
        tools: "",
        extensionsMode: "unset",
        extensionsList: "",
        skillsMode: "unset",
        skillsList: "",
        maxTurns: "",
        promptMode: "unset",
        enabled: true,
      },
    ]);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Agents" variant="plain" hideTitle>
        <SettingsRow
          {...searchableSetting("agents")}
          description="Subagents T3 registers with Pi. Disabled agents stay saved but are not offered to sessions."
          control={
            <Button size="sm" variant="outline" disabled={environmentWide} onClick={addAgent}>
              <PlusIcon />
              Add agent
            </Button>
          }
        >
          {environmentWide ? (
            <p className="mt-2 mb-2 text-sm text-muted-foreground">
              Agents are configured for the whole environment. Select an environment to edit them.
            </p>
          ) : definitions.length === 0 ? (
            <p className="mt-2 mb-2 text-sm text-muted-foreground">
              No agents yet. Add one to define a subagent.
            </p>
          ) : (
            <div className="mt-2 mb-2 space-y-2">
              {definitions.map((definition, index) => (
                <AgentCard
                  key={definition.id}
                  definition={definition}
                  index={index}
                  onChange={(patch) => updateAt(index, patch)}
                  onCommit={() => commit(definitions)}
                  onCommitPatch={(patch) =>
                    commit(
                      definitions.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
                    )
                  }
                  onToggle={(enabled) =>
                    commit(
                      definitions.map((entry, i) => (i === index ? { ...entry, enabled } : entry)),
                    )
                  }
                  onRemove={() => commit(definitions.filter((_, i) => i !== index))}
                />
              ))}
            </div>
          )}
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
