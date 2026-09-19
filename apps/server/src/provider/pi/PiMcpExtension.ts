// @effect-diagnostics nodeBuiltinImport:off - materializes a standalone extension consumed by stock Pi.
import { materializePiExtension } from "./PiExtensionFile.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";

/**
 * Environment T3 sets on the Pi process so the materialized extension can reach
 * the same `/mcp` endpoint and per-session credential the built-in providers
 * use. Pi has no MCP client of its own, so the extension is the client.
 */
export const PI_MCP_ENV = {
  endpoint: "T3_MCP_URL",
  bearerToken: "T3_MCP_BEARER_TOKEN",
  capabilities: "T3_MCP_CAPABILITIES",
} as const;

/**
 * T3-owned Pi extension. It speaks MCP Streamable HTTP to the server's `/mcp`
 * endpoint, registers the tools the thread credential grants as Pi tools, and
 * forwards calls. It never writes to stdout: in `--mode rpc` that is Pi's
 * protocol channel.
 *
 * Written without template literals or escape sequences so it can live in a
 * `String.raw` literal; the env names are substituted from {@link PI_MCP_ENV}.
 */
const PI_MCP_EXTENSION_TEMPLATE = String.raw`
"use strict";
const ENDPOINT_ENV = "__T3_MCP_URL__";
const TOKEN_ENV = "__T3_MCP_BEARER_TOKEN__";
const CAPABILITIES_ENV = "__T3_MCP_CAPABILITIES__";
const PROTOCOL_VERSION = "2025-06-18";
const SESSION_HEADER = "mcp-session-id";
const PROTOCOL_HEADER = "mcp-protocol-version";
const HANDSHAKE_TIMEOUT_MS = 5000;
const SNIPPET_MAX_CHARS = 160;
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
/**
 * Which credential capability each server toolkit needs. Fail closed: a tool
 * whose name matches no rule is never registered, so a toolkit added to the
 * server cannot reach Pi without a deliberate decision here.
 */
const CAPABILITY_RULES = [
  { capability: "preview", matches: (name) => name.startsWith("preview_") },
  { capability: "device", matches: (name) => name.startsWith("device_") },
  { capability: "pull-requests", matches: (name) => name.includes("pull_request") },
];
const PREVIEW_GUIDELINE =
  "For browser work in T3, call preview_status first; it reports whether an automation-capable preview tab is attached. Call preview_open when none is attached instead of concluding the browser is unavailable.";
/**
 * Browser tools this extension replaces: they drive a separate headless
 * Chromium, while preview_* drives the tab the user is watching. Removing them
 * from the active set keeps them out of the model's tool list, so browser work
 * cannot split across two browsers.
 */
const SUPERSEDED_BROWSER_TOOLS = [
  "frontend_open",
  "frontend_act",
  "frontend_screenshot",
  "frontend_console",
  "frontend_eval",
];
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function capabilityForTool(name) {
  for (const rule of CAPABILITY_RULES) {
    if (rule.matches(name)) return rule.capability;
  }
  return undefined;
}

function firstSentence(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length === 0) return undefined;
  const stop = trimmed.indexOf(". ");
  const sentence = stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
  return sentence.length > SNIPPET_MAX_CHARS
    ? sentence.slice(0, SNIPPET_MAX_CHARS - 3) + "..."
    : sentence;
}

function textContent(result) {
  const parts = result !== null && typeof result === "object" && Array.isArray(result.content) ? result.content : [];
  return parts
    .filter((part) => part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function toToolContent(result) {
  const parts = result !== null && typeof result === "object" && Array.isArray(result.content) ? result.content : [];
  const content = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "image" && typeof part.data === "string") {
      content.push({
        type: "image",
        data: part.data,
        mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png",
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "The T3 tool completed without a result." });
  return content;
}

export default async function t3McpToolkit(pi) {
  const endpoint = process.env[ENDPOINT_ENV];
  const token = process.env[TOKEN_ENV];
  if (typeof endpoint !== "string" || endpoint.length === 0) return;
  if (typeof token !== "string" || token.length === 0) return;
  const granted = new Set(
    String(process.env[CAPABILITIES_ENV] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  let sessionId;
  let nextId = 0;

  const request = async (method, params, signal) => {
    nextId += 1;
    const id = nextId;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + token,
    };
    // The server creates a session on initialize and rejects every later
    // request that omits it, or the negotiated protocol version.
    if (sessionId !== undefined) {
      headers[SESSION_HEADER] = sessionId;
      headers[PROTOCOL_HEADER] = PROTOCOL_VERSION;
    }
    const init = {
      method: "POST",
      headers,
      body: JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }),
    };
    if (signal !== undefined) init.signal = signal;
    const response = await fetch(endpoint, init);
    const responseSessionId = response.headers.get(SESSION_HEADER);
    if (typeof responseSessionId === "string" && responseSessionId.length > 0) {
      sessionId = responseSessionId;
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "T3 rejected the tool credential. Credentials are bound to one agent session and expire; start a new turn or thread for a fresh one.",
      );
    }
    if (response.status === 202 || response.status === 204) return undefined;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        "T3 tool request failed with HTTP " + response.status + (body.length > 0 ? ": " + body.slice(0, 400) : ""),
      );
    }
    if (body.trim().length === 0) return undefined;
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const message = messages.find((candidate) => candidate !== null && typeof candidate === "object" && candidate.id === id);
    if (message === undefined) throw new Error("T3 tool response did not match request " + id + ".");
    if (message.error !== null && message.error !== undefined) {
      throw new Error("T3 tool error: " + String(message.error.message ?? message.error.code ?? "unknown"));
    }
    return message.result;
  };

  let listed;
  try {
    const initialized = await request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t3-code-pi", version: "1" } },
      AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    );
    if (initialized === undefined) throw new Error("T3 did not answer the MCP initialize request.");
    await request("notifications/initialized", undefined, AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS));
    listed = await request("tools/list", {}, AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS));
  } catch (error) {
    // A thread with no T3 tools is recoverable; a Pi session that fails to
    // start is not. stderr is the only channel that does not corrupt RPC.
    process.stderr.write("t3-mcp-extension: could not load T3 tools: " + describe(error) + "\n");
    return;
  }

  const tools = listed !== null && typeof listed === "object" && Array.isArray(listed.tools) ? listed.tools : [];
  // Pi exposes no bound tool registry while extensions load, so a name another
  // extension already claimed is left to Pi's own resolution (first wins).
  let registeredPreviewTool = false;
  for (const tool of tools) {
    if (tool === null || typeof tool !== "object") continue;
    const name = tool.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const capability = capabilityForTool(name);
    if (capability === undefined || !granted.has(capability)) continue;
    const annotations = tool.annotations !== null && typeof tool.annotations === "object" ? tool.annotations : {};
    const definition = {
      name,
      label: typeof annotations.title === "string" && annotations.title.length > 0 ? annotations.title : name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters:
        tool.inputSchema !== null && typeof tool.inputSchema === "object" ? tool.inputSchema : EMPTY_SCHEMA,
      async execute(toolCallId, params, signal) {
        const result = await request(
          "tools/call",
          { name, arguments: params === null || params === undefined ? {} : params },
          signal,
        );
        if (result !== null && typeof result === "object" && result.isError === true) {
          const failure = textContent(result);
          throw new Error(failure.length > 0 ? failure : "The T3 tool reported an error.");
        }
        return { content: toToolContent(result), details: {} };
      },
    };
    const snippet = firstSentence(tool.description);
    if (snippet !== undefined) definition.promptSnippet = snippet;
    // One entry point carries the browser workflow guideline; attaching it to
    // every preview tool would repeat the same bullet in the system prompt.
    if (name === "preview_status") definition.promptGuidelines = [PREVIEW_GUIDELINE];
    pi.registerTool(definition);
    if (capability === "preview") registeredPreviewTool = true;
  }

  if (registeredPreviewTool) {
    // Session start is the first point where Pi's runtime is bound, so it is
    // the first chance to read and write the active tool set. Only strip the
    // superseded tools when the replacement registered: a failed handshake
    // must leave the user's own browser tools in place.
    pi.on("session_start", () => {
      const active = pi.getActiveTools();
      const kept = active.filter((name) => !SUPERSEDED_BROWSER_TOOLS.includes(name));
      if (kept.length !== active.length) pi.setActiveTools(kept);
    });
  }
}
`;

/** Placeholders keep the env names single-sourced without a normal template literal, whose escape handling would corrupt the extension source. */
export function renderPiMcpExtensionSource(): string {
  return PI_MCP_EXTENSION_TEMPLATE.replaceAll("__T3_MCP_URL__", PI_MCP_ENV.endpoint)
    .replaceAll("__T3_MCP_BEARER_TOKEN__", PI_MCP_ENV.bearerToken)
    .replaceAll("__T3_MCP_CAPABILITIES__", PI_MCP_ENV.capabilities);
}

/** The MCP extension that stock Pi loads with `--extension`. */
export function materializePiMcpExtension(stateDir: string): Promise<string> {
  return materializePiExtension({
    stateDir,
    filePrefix: "t3-mcp-",
    source: renderPiMcpExtensionSource(),
  });
}

/**
 * A Pi process environment carrying one thread's MCP credential, or the base
 * environment when the adapter has none to give.
 */
export function withPiMcpEnvironment(
  base: NodeJS.ProcessEnv,
  session: McpProviderSession.McpProviderSessionConfig,
): NodeJS.ProcessEnv {
  return {
    ...McpProviderSession.withAgentDeviceEnvironment(base, session),
    [PI_MCP_ENV.endpoint]: session.endpoint,
    [PI_MCP_ENV.bearerToken]: session.authorizationHeader.replace(/^Bearer\s+/, ""),
    [PI_MCP_ENV.capabilities]: [...session.capabilities].join(","),
  };
}
