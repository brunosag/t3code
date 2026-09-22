// @effect-diagnostics nodeBuiltinImport:off - materializes a standalone extension consumed by stock Pi.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { AgentDefinition } from "@t3tools/contracts";
import { materializePiExtension } from "./PiExtensionFile.ts";

/**
 * Environment T3 sets on the Pi process so the materialized extension can find
 * the definitions file the driver writes. A path rather than the definitions
 * themselves: the file is re-read on every session start, so edits reach new
 * threads without restarting the provider.
 */
export const PI_AGENTS_ENV = {
  definitionsPath: "T3_PI_AGENTS_PATH",
} as const;

/**
 * T3-owned Pi extension. It pushes T3's agent definitions into the pi-subagents
 * roster over that extension's cross-extension RPC, so T3 can own agents without
 * writing into Pi's own agent directories. Written without template literals or
 * escape sequences so it can live in a `String.raw` literal; the env name is
 * substituted from {@link PI_AGENTS_ENV}.
 */
const PI_AGENTS_EXTENSION_SOURCE = String.raw`
"use strict";
import { readFileSync, writeSync } from "node:fs";

const DEFINITIONS_PATH_ENV = "__T3_PI_AGENTS_PATH__";
const RPC_CHANNEL = "subagents:rpc:registerAgents";
const CHANNEL_FD = 3;

let api;

function readDefinitions() {
  const path = process.env[DEFINITIONS_PATH_ENV];
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A missing or unreadable file means "no T3-owned agents"; it must never
    // take the session down.
    return [];
  }
}

function register() {
  if (!api) return;
  const requestId = "t3-agents-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  // Fire-and-forget: the subagents extension replaces its layer wholesale, so a
  // duplicate or late registration is idempotent.
  api.events.emit(RPC_CHANNEL, { requestId, agents: readDefinitions() });
}

/**
 * Forward one settled run to T3 over the extension channel (fd 3). The
 * subagents extension emits these events even when it suppresses the parent
 * completion notification, so this is what lets T3 settle a background agent
 * whose result the parent already consumed.
 */
function forward(event, data) {
  if (!data || typeof data.id !== "string" || data.id.length === 0) return;
  const message = {
    type: "subagent.activity",
    event: event,
    agentId: data.id,
    agentType: data.type,
    description: data.description,
    status: data.status,
    error: data.error,
    result: data.result,
    toolUses: data.toolUses,
    durationMs: data.durationMs,
    tokens: data.tokens,
  };
  try {
    const bytes = Buffer.from(JSON.stringify(message) + "\n", "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(CHANNEL_FD, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("no write progress");
      offset += written;
    }
  } catch {
    // No channel, or T3 is gone. Either way there is nothing to forward to.
  }
}

export default function t3Agents(pi) {
  api = pi;
  pi.on("session_start", register);
  // The subagents extension registers its RPC handlers on its own
  // session_start and then broadcasts readiness. Registering on both means
  // that whichever order the two extensions load in, at least one fires after
  // its handler exists.
  pi.events.on("subagents:ready", register);
  pi.events.on("subagents:completed", (data) => forward("completed", data));
  pi.events.on("subagents:failed", (data) => forward("failed", data));
}
`;

/** Materialize the agent-registration extension that stock Pi loads with `--extension`. */
export function materializePiAgentsExtension(stateDir: string): Promise<string> {
  return materializePiExtension({
    stateDir,
    filePrefix: "t3-agents-",
    source: PI_AGENTS_EXTENSION_SOURCE.replaceAll(
      "__T3_PI_AGENTS_PATH__",
      PI_AGENTS_ENV.definitionsPath,
    ),
  });
}

/** Where the driver writes the definitions the extension reads. */
export function piAgentDefinitionsPath(stateDir: string): string {
  return NodePath.join(stateDir, "pi", "agents.json");
}

/**
 * The wire shape `subagents:rpc:registerAgents` validates. Disabled definitions
 * are dropped here rather than sent as `enabled: false`: the fork registers
 * every entry it receives, so omission is how T3 disables one.
 */
export interface PiAgentDefinitionWire {
  name: string;
  displayName?: string;
  description?: string;
  systemPrompt: string;
  model?: string;
  thinking?: string;
  extensions?: boolean | readonly string[];
  skills?: boolean | readonly string[];
  maxTurns?: number;
  promptMode?: "replace" | "append" | "auto";
  tools?: string[];
}

export function toPiAgentDefinitions(
  definitions: readonly AgentDefinition[],
): PiAgentDefinitionWire[] {
  return definitions
    .filter((definition) => definition.enabled !== false)
    .map((definition) => ({
      name: definition.name,
      ...(definition.displayName ? { displayName: definition.displayName } : {}),
      ...(definition.description ? { description: definition.description } : {}),
      systemPrompt: definition.systemPrompt,
      ...(definition.model ? { model: definition.model } : {}),
      ...(definition.thinking ? { thinking: definition.thinking } : {}),
      ...(definition.extensions !== undefined ? { extensions: definition.extensions } : {}),
      ...(definition.skills !== undefined ? { skills: definition.skills } : {}),
      ...(definition.maxTurns !== undefined ? { maxTurns: definition.maxTurns } : {}),
      ...(definition.promptMode !== undefined ? { promptMode: definition.promptMode } : {}),
      ...(definition.tools && definition.tools.length > 0 ? { tools: [...definition.tools] } : {}),
    }));
}

/**
 * Write the definitions file. A torn write would only make the extension read
 * nothing for one session, and writes happen on settings changes while reads
 * happen at session start, so a plain write is enough here.
 */
export async function writePiAgentDefinitions(
  stateDir: string,
  definitions: readonly AgentDefinition[],
): Promise<void> {
  const path = piAgentDefinitionsPath(stateDir);
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, `${JSON.stringify(toPiAgentDefinitions(definitions), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** A Pi process environment that points the extension at the definitions file. */
export function withPiAgentsEnvironment(
  base: NodeJS.ProcessEnv,
  definitionsPath: string,
): NodeJS.ProcessEnv {
  return { ...base, [PI_AGENTS_ENV.definitionsPath]: definitionsPath };
}
