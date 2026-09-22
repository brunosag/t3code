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
 * writing into Pi's own agent directories. The push is `exclusive`: Pi's own
 * agent files are not part of the roster while this extension is loaded.
 * Every outcome — definitions unreadable, the payload rejected, or no handler
 * at all — is reported back over the side channel as a `subagent.registration`
 * message, because each one otherwise fails silently and lets Pi's agent files
 * run instead of T3's.
 * Written without template literals or escape sequences so it can live in a
 * `String.raw` literal; the env name is substituted from {@link PI_AGENTS_ENV}.
 */
const PI_AGENTS_EXTENSION_SOURCE = String.raw`
"use strict";
import { readFileSync, writeSync } from "node:fs";

const DEFINITIONS_PATH_ENV = "__T3_PI_AGENTS_PATH__";
const RPC_CHANNEL = "subagents:rpc:registerAgents";
const CHANNEL_FD = 3;
// The registration rides the same bus as session start, so a reply normally
// arrives in the same tick; the timer exists only to notice a subagents
// extension that has no registerAgents handler at all.
const ACK_TIMEOUT_MS = 5000;

let api;
// One live registration: a newer register() supersedes an unanswered older one.
let pending = null;
// Failure text already reported, so the session_start + subagents:ready pair
// cannot deliver the same warning twice.
let lastError = "";

function readDefinitions() {
  const path = process.env[DEFINITIONS_PATH_ENV];
  if (!path) {
    return { agents: [], failure: "T3_PI_AGENTS_PATH is not set on the Pi process." };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) {
      return { agents: [], failure: "Definitions file is not an array: " + path };
    }
    return { agents: parsed, failure: undefined };
  } catch (err) {
    return {
      agents: [],
      failure:
        "Definitions file unreadable (" + path + "): " +
        (err && err.message ? err.message : String(err)),
    };
  }
}

function writeLine(message) {
  const bytes = Buffer.from(JSON.stringify(message) + "\n", "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(CHANNEL_FD, bytes, offset, bytes.length - offset);
    if (written === 0) throw new Error("no write progress");
    offset += written;
  }
}

/** Report one roster outcome to T3. Identical failures are reported once. */
function report(message) {
  if (message.ok) {
    lastError = "";
  } else {
    if (message.error === lastError) return;
    lastError = message.error || "unknown failure";
  }
  try {
    writeLine(message);
  } catch {
    // No channel, or T3 is gone. Either way there is nothing to report to.
  }
}

function clearPending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.unsubscribe();
  pending = null;
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
    writeLine(message);
  } catch {
    // No channel, or T3 is gone. Either way there is nothing to forward to.
  }
}

/**
 * Push T3's roster and wait for the handler's reply envelope. The reply is the
 * only proof that a registerAgents handler exists and accepted the payload —
 * a subagents extension without one drops the event without a trace.
 */
function register() {
  if (!api) return;
  const read = readDefinitions();
  clearPending();
  const requestId =
    "t3-agents-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  let settled = false;
  const settle = function (message) {
    if (settled) return;
    settled = true;
    clearPending();
    report(message);
  };
  const unsubscribe = api.events.on(RPC_CHANNEL + ":reply:" + requestId, function (reply) {
    if (!reply || !reply.success) {
      settle({
        type: "subagent.registration",
        requestId: requestId,
        ok: false,
        error:
          "Pi's subagents extension rejected T3's agent roster: " +
          (reply && reply.error ? reply.error : "no reply payload"),
      });
      return;
    }
    const accepted =
      reply.data && typeof reply.data.count === "number"
        ? reply.data.count
        : read.agents.length;
    // A handler that never heard of the exclusive claim would merge Pi's agent
    // files back in while still replying success.
    if (!reply.data || reply.data.exclusive !== true) {
      settle({
        type: "subagent.registration",
        requestId: requestId,
        ok: false,
        error:
          "Pi's subagents extension accepted T3's agent roster without honoring its " +
          "exclusive claim, so Pi's own agent files still apply. Update pi-setup.",
      });
      return;
    }
    if (accepted !== read.agents.length) {
      settle({
        type: "subagent.registration",
        requestId: requestId,
        ok: false,
        error:
          "Pi's subagents extension registered " +
          accepted +
          " of " +
          read.agents.length +
          " T3 agent definitions.",
      });
      return;
    }
    settle({ type: "subagent.registration", requestId: requestId, ok: true, count: read.agents.length });
  });
  const timer = setTimeout(function () {
    settle({
      type: "subagent.registration",
      requestId: requestId,
      ok: false,
      error:
        "Pi's subagents extension never acknowledged T3's agent roster; its " +
        "registerAgents RPC is missing, so Pi's own agent files would run instead. " +
        "Update pi-setup.",
    });
  }, ACK_TIMEOUT_MS);
  pending = { timer: timer, unsubscribe: unsubscribe };
  // exclusive: T3 owns this session's roster, so Pi's agent files are not
  // merged in at all — not for fields, not for names T3 omitted.
  api.events.emit(RPC_CHANNEL, { requestId: requestId, agents: read.agents, exclusive: true });
  if (read.failure) {
    settle({
      type: "subagent.registration",
      requestId: requestId,
      ok: false,
      error: read.failure,
    });
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
