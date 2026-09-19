// @effect-diagnostics nodeBuiltinImport:off - materializes a standalone extension consumed by stock Pi.
import { materializePiExtension } from "./PiExtensionFile.ts";

/**
 * T3-owned Pi extension. It registers the rich `t3_ask_user` tool and exchanges
 * requests with the owning adapter over inherited fd 3, leaving Pi's RPC
 * protocol untouched.
 */
export const PI_USER_INPUT_EXTENSION_SOURCE = String.raw`
import { createReadStream, writeSync } from "node:fs";
import { Socket } from "node:net";
import { Type } from "typebox";

const CHANNEL_FD = 3;
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const pending = new Map();
// T3 renders questions itself, so any other question tool would bypass its UI.
const SUPERSEDED_TOOLS = ["ask_user"];
let buffer = "";
let input;

function writeMessage(message) {
  const bytes = Buffer.from(JSON.stringify(message) + "\n", "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(CHANNEL_FD, bytes, offset, bytes.length - offset);
    if (written === 0) throw new Error("T3 user-input channel made no write progress");
    offset += written;
  }
}

function settlePending(message) {
  if (message === null || typeof message !== "object" || message.type !== "user-input.response") {
    return;
  }
  const request = pending.get(message.requestId);
  if (!request) return;
  pending.delete(message.requestId);
  request.cleanup();
  if (typeof message.error === "string" && message.error.length > 0) {
    request.reject(new Error(message.error));
    return;
  }
  request.resolve(message);
}

function rejectPending(error) {
  for (const request of pending.values()) {
    request.cleanup();
    request.reject(error);
  }
  pending.clear();
}

function openInput() {
  try {
    return createReadStream(null, { fd: CHANNEL_FD, autoClose: false });
  } catch {
    return new Socket({ fd: CHANNEL_FD, readable: true, writable: false });
  }
}

function attachInput(stream, allowSocketFallback) {
  input = stream;
  let sawData = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    sawData = true;
    try {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > MAX_LINE_CHARS) throw new Error("T3 user-input response is too large");
        if (line.length > 0) settlePending(JSON.parse(line));
        newlineIndex = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_CHARS) throw new Error("T3 user-input response is too large");
    } catch (error) {
      rejectPending(error);
      stream.destroy();
      if (input === stream) input = undefined;
    }
  });
  stream.on("error", (error) => {
    if (!sawData && allowSocketFallback) {
      stream.removeAllListeners();
      stream.destroy();
      try {
        attachInput(new Socket({ fd: CHANNEL_FD, readable: true, writable: false }), false);
        return;
      } catch (fallbackError) {
        rejectPending(fallbackError);
      }
    } else {
      rejectPending(error);
    }
    if (input === stream) input = undefined;
  });
  stream.on("close", () => {
    if (input !== stream) return;
    rejectPending(new Error("T3 user-input channel closed"));
    input = undefined;
  });
}

function ensureInput() {
  if (input) return;
  const stream = openInput();
  attachInput(stream, !(stream instanceof Socket));
}

function requestUserInput(requestId, questions, signal) {
  ensureInput();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ cancelled: true });
      return;
    }
    const abort = () => {
      if (!pending.delete(requestId)) return;
      writeMessage({ type: "user-input.cancel", requestId });
      resolve({ cancelled: true });
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    pending.set(requestId, { resolve, reject, cleanup });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      writeMessage({ type: "user-input.request", requestId, questions });
    } catch (error) {
      pending.delete(requestId);
      cleanup();
      reject(error);
    }
  });
}

const Option = Type.Object({
  label: Type.String({ minLength: 1, description: "Short visible option label" }),
  description: Type.Optional(Type.String({ description: "One-line explanation that helps the user choose" })),
  value: Type.Optional(Type.String({ description: "Value returned instead of the label" })),
});
const Question = Type.Object({
  id: Type.String({ minLength: 1, description: "Stable answer key, unique within this request" }),
  header: Type.String({ minLength: 1, description: "Short section label, such as Scope or Tone" }),
  question: Type.String({ minLength: 1, description: "Direct question shown to the user" }),
  options: Type.Array(Option, { description: "Choices; use an empty array for free text" }),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple choices" })),
  allowCustomAnswer: Type.Optional(Type.Boolean({ description: "Allow a free-text answer; defaults to true" })),
});

export default function t3UserInput(pi) {
  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const kept = active.filter((name) => !SUPERSEDED_TOOLS.includes(name));
    if (kept.length !== active.length) pi.setActiveTools(kept);
  });
  pi.on("session_shutdown", () => {
    input?.destroy();
    input = undefined;
  });
  pi.registerTool({
    name: "t3_ask_user",
    label: "Ask User",
    description: "Ask one or more user questions in T3. Supports option descriptions, multi-select, and free-text answers.",
    promptSnippet: "Ask the user one or more rich questions in T3",
    promptGuidelines: [
      "Use t3_ask_user when a decision needs the user's input; prefer it over other question tools and batch related questions when possible.",
    ],
    parameters: Type.Object({
      questions: Type.Array(Question, { minItems: 1, description: "Questions to present together" }),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const ids = new Set();
      const questions = params.questions.map((question) => {
        const id = question.id.trim();
        const header = question.header.trim();
        const prompt = question.question.trim();
        if (!id || !header || !prompt)
          throw new Error("t3_ask_user question text cannot be blank");
        if (ids.has(id)) throw new Error("t3_ask_user question ids must be unique");
        if (question.options.length === 0 && question.allowCustomAnswer === false) {
          throw new Error("t3_ask_user questions without options must allow a custom answer");
        }
        const options = question.options.map((option) => ({
          ...option,
          label: option.label.trim(),
          description: option.description ?? "",
        }));
        if (options.some((option) => !option.label)) {
          throw new Error("t3_ask_user option labels cannot be blank");
        }
        ids.add(id);
        return {
          ...question,
          id,
          header,
          question: prompt,
          options,
          multiSelect: question.multiSelect === true,
        };
      });
      const response = await requestUserInput(toolCallId, questions, signal);
      if (response.cancelled === true) {
        return {
          content: [{ type: "text", text: "User cancelled the questions." }],
          details: { cancelled: true },
        };
      }
      const answers = response.answers ?? {};
      return {
        content: [{ type: "text", text: "User answers:\n" + JSON.stringify(answers, null, 2) }],
        details: { cancelled: false, answers },
      };
    },
  });
}
`;

/** Materialize the user-input extension that stock Pi loads with `--extension`. */
export function materializePiUserInputExtension(stateDir: string): Promise<string> {
  return materializePiExtension({
    stateDir,
    filePrefix: "t3-user-input-",
    source: PI_USER_INPUT_EXTENSION_SOURCE,
  });
}
