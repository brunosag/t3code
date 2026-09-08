/**
 * Pi text generation.
 *
 * Runs the headless commit/PR/branch/title prompts through the Pi RPC
 * transport (`./PiRpcClient.ts`, owned by the parallel transport worker) and
 * decodes the same structured JSON the other CLI text-generation backends
 * use. Prompt builders, JSON extraction, output schemas, and sanitizers are
 * shared with those backends; only the transport below is Pi-specific.
 *
 * Transport assumptions (kept minimal so all configured Pi behavior applies
 * naturally — no config management, tool, or system-prompt overrides):
 * - A fresh client per operation uses default session persistence
 *   (`sessionPath` is left unset; never a no-session mode).
 * - `request("set_model", { provider, model })` switches models. The
 *   selection `model` is split on the first slash into provider/modelId;
 *   `"default"` keeps the runtime's active default and skips the call.
 *   Thinking options are not exposed by Pi and are never sent.
 * - `request("prompt", { message })` delivers the prompt. The request
 *   resolving is not the result — completion is signaled by events.
 * - `message_end` events with an assistant role carry the authoritative
 *   output text; `agent_settled` marks the turn final. `error`/`aborted`
 *   events (or an `agent_settled` carrying an error/aborted reason) fail
 *   the operation, as does the process exiting before settlement.
 *
 * @module piTextGeneration
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../../textGeneration/TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../../textGeneration/TextGenerationUtils.ts";

const PI_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/** Wire shape of the neighboring Pi RPC transport (see `./PiRpcClient.ts`). */
export interface PiRpcClientInit {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionPath?: string | undefined;
  readonly onEvent: (event: Record<string, unknown>) => void;
  readonly onExit: (error: Error) => void;
  readonly requestTimeoutMs?: number | undefined;
}

/** Structural client surface used here; matches the neighboring transport. */
export interface PiRpcClientLike {
  readonly request: (type: string, fields?: Record<string, unknown>) => Promise<unknown>;
  readonly send: (record: Record<string, unknown>) => void;
  readonly close: () => Promise<void>;
}

export type PiRpcClientFactory = (
  init: PiRpcClientInit,
) => PiRpcClientLike | Promise<PiRpcClientLike>;

export interface PiTextGenerationConfig {
  readonly binaryPath: string;
}

export interface PiTextGenerationOverrides {
  /** Injectable transport for tests; defaults to the neighboring client. */
  readonly createClient?: PiRpcClientFactory | undefined;
}

type PiTextOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const defaultCreatePiRpcClient: PiRpcClientFactory = async (init) => {
  // The PiRpcClient class lands via the parallel transport worker; resolve it
  // lazily so this module typechecks and tests (with an injected factory)
  // run before/after it lands. The structural checks below guard drift.
  // @ts-ignore - neighboring PiRpcClient.ts may not exist yet on this branch.
  const clientModule: unknown = await import("./PiRpcClient.ts");
  if (!Predicate.isObject(clientModule)) {
    throw new Error("Pi RPC transport is unavailable: PiRpcClient module has no exports.");
  }
  const Candidate = clientModule["PiRpcClient"];
  if (typeof Candidate !== "function") {
    throw new Error("Pi RPC transport is unavailable: PiRpcClient.ts does not export PiRpcClient.");
  }
  const client: unknown = new (
    Candidate as new (init: PiRpcClientInit) => unknown
  )(init);
  if (
    !Predicate.isObject(client) ||
    typeof client["request"] !== "function" ||
    typeof client["close"] !== "function"
  ) {
    throw new Error("Pi RPC transport is unavailable: PiRpcClient has an unexpected shape.");
  }
  return client as unknown as PiRpcClientLike;
};

const failOperation = (
  operation: PiTextOperation,
  detail: string,
  cause?: unknown,
): TextGenerationError =>
  cause === undefined
    ? new TextGenerationError({ operation, detail })
    : new TextGenerationError({ operation, detail, cause });

/** Split `provider/modelId` on the first slash; null when there is no split. */
const splitPiModelSelection = (
  model: string,
): { readonly provider: string; readonly modelId: string } | null => {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash >= model.length - 1) {
    return null;
  }
  return {
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
  };
};

const readStringField = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" ? value : null;
};

const readNestedRecord = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null => {
  const value = record[key];
  return Predicate.isObject(value) ? value : null;
};

/** Joinassistant text parts (`[{ type: "text", text }]`) found in `value`. */
const readTextParts = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const texts: Array<string> = [];
  for (const part of value) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (
      Predicate.isObject(part) &&
      part["type"] === "text" &&
      typeof part["text"] === "string"
    ) {
      texts.push(part["text"]);
    }
  }
  return texts.length > 0 ? texts.join("") : null;
};

/**
 * Authoritative assistant text for a `message_end` event, or null when the
 * event is not an assistant message or carries no text.
 */
const readMessageEndAssistantText = (event: Record<string, unknown>): string | null => {
  if (event["type"] !== "message_end") {
    return null;
  }
  const nested = readNestedRecord(event, "message");
  const role = readStringField(event, "role") ?? (nested ? readStringField(nested, "role") : null);
  if (role !== null && role.toLowerCase() !== "assistant") {
    return null;
  }
  return (
    readStringField(event, "text") ??
    readStringField(event, "content") ??
    readStringField(event, "delta") ??
    (nested
      ? (readTextParts(nested["content"]) ??
        readStringField(nested, "text"))
      : null) ??
    readTextParts(event["parts"]) ??
    null
  );
};

const SETTLEMENT_FAILURE_REASONS = new Set([
  "error",
  "aborted",
  "abort",
  "cancelled",
  "canceled",
  "failed",
  "failure",
  "timeout",
  "timed_out",
]);

const readErrorDetail = (event: Record<string, unknown>): string | null => {
  const nested = readNestedRecord(event, "message") ?? readNestedRecord(event, "error");
  const detail =
    readStringField(event, "message") ??
    readStringField(event, "detail") ??
    readStringField(event, "reason") ??
    (nested
      ? (readStringField(nested, "message") ?? readStringField(nested, "detail"))
      : null);
  const trimmed = detail?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

/**
 * Failure detail when an `agent_settled` event carries an error/aborted
 * outcome, or null when the settlement reads as success.
 */
const readAgentSettledFailure = (event: Record<string, unknown>): string | null => {
  if (event["ok"] === false || event["success"] === false) {
    return readErrorDetail(event) ?? "Pi agent settled unsuccessfully.";
  }
  if (event["error"] !== undefined && event["error"] !== null) {
    const nested = readNestedRecord(event, "error");
    const detail = nested ? readErrorDetail(nested) : null;
    return detail ?? "Pi agent settled with an error.";
  }
  for (const key of ["reason", "status", "outcome", "state", "result"]) {
    const value = event[key];
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim().toLowerCase();
    if (SETTLEMENT_FAILURE_REASONS.has(normalized)) {
      return `Pi agent settled with ${key} '${value.trim()}'.`;
    }
  }
  return null;
};

/** Failure detail when a `prompt` RPC result itself reports an error. */
const readPromptResultFailure = (result: unknown): string | null => {
  if (!Predicate.isObject(result)) {
    return null;
  }
  if (result["ok"] === false || result["success"] === false) {
    return readErrorDetail(result) ?? "Pi prompt request was rejected.";
  }
  if (result["error"] !== undefined && result["error"] !== null) {
    const nested = readNestedRecord(result, "error");
    const detail = nested ? readErrorDetail(nested) : null;
    return detail ?? "Pi prompt request returned an error.";
  }
  const status = result["status"];
  if (typeof status === "string" && SETTLEMENT_FAILURE_REASONS.has(status.trim().toLowerCase())) {
    return `Pi prompt request settled with status '${status.trim()}'.`;
  }
  return null;
};

/**
 * Build a Pi text-generation service bound to a Pi binary. The factory is
 * synchronous — every method still returns an Effect — so no Effect factory
 * (and no `tell main` follow-up) is needed.
 */
export const makePiTextGeneration = (
  config: PiTextGenerationConfig,
  environment: NodeJS.ProcessEnv = process.env,
  overrides: PiTextGenerationOverrides = {},
): TextGeneration.TextGeneration["Service"] => {
  const binaryPath = config.binaryPath;
  const resolvedEnvironment = environment ?? process.env;
  const createClient = overrides.createClient ?? defaultCreatePiRpcClient;

  const runPiJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: PiTextOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      let assistantText = "";
      const settled = yield* Deferred.make<void, TextGenerationError>();
      const failSettled = (detail: string, cause?: unknown): void => {
        Deferred.doneUnsafe(settled, Effect.fail(failOperation(operation, detail, cause)));
      };
      const succeedSettled = (): void => {
        Deferred.doneUnsafe(settled, Effect.void);
      };

      const onEvent = (event: Record<string, unknown>): void => {
        try {
          const type = event["type"];
          if (type === "message_end") {
            const text = readMessageEndAssistantText(event);
            if (text !== null && text.length > 0) {
              assistantText += text;
            }
            return;
          }
          if (type === "agent_settled") {
            const failure = readAgentSettledFailure(event);
            if (failure !== null) {
              failSettled(failure, event);
            } else {
              succeedSettled();
            }
            return;
          }
          if (type === "error") {
            failSettled(readErrorDetail(event) ?? "Pi agent reported an error.", event);
            return;
          }
          if (type === "aborted" || type === "abort") {
            failSettled("Pi agent request was aborted.", event);
          }
        } catch (cause) {
          failSettled("Pi agent event handling failed.", cause);
        }
      };
      const onExit = (error: Error): void => {
        failSettled(
          `Pi process exited before settling${error?.message ? `: ${error.message}` : "."}`,
          error,
        );
      };

      // Scoped so cancellation, errors, and the timeout below always close
      // the Pi process. New sessions use default persistence: no sessionPath
      // (never a no-session mode) and no tool/system-prompt overrides.
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => Promise.resolve().then(() => createClient({
            binaryPath,
            cwd,
            environment: resolvedEnvironment,
            onEvent,
            onExit,
            requestTimeoutMs: PI_TIMEOUT_MS,
          })),
          catch: (cause) =>
            failOperation(operation, "Failed to start Pi RPC client.", cause),
        }),
        (piClient) => Effect.promise(() => piClient.close()).pipe(Effect.ignore),
      );

      yield* Effect.gen(function* () {
        if (modelSelection.model !== "default") {
          const split = splitPiModelSelection(modelSelection.model);
          if (!split) {
            return yield* failOperation(
              operation,
              "Pi model selection must use the 'provider/model' format.",
            );
          }
          yield* Effect.tryPromise({
            try: () =>
              client.request("set_model", {
                provider: split.provider,
                model: split.modelId,
              }),
            catch: (cause) =>
              isTextGenerationError(cause)
                ? cause
                : failOperation(
                    operation,
                    "Failed to set Pi model for text generation.",
                    cause,
                  ),
          });
        }

        yield* Effect.tryPromise({
          try: () =>
            client.request("prompt", { message: prompt }).then((result) => {
              const failure = readPromptResultFailure(result);
              if (failure !== null) {
                throw failOperation(operation, failure, result);
              }
              return result;
            }),
          catch: (cause) =>
            isTextGenerationError(cause)
              ? cause
              : failOperation(operation, "Pi prompt request failed.", cause),
        });

        yield* Deferred.await(settled);
      }).pipe(
        Effect.timeoutOption(PI_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(failOperation(operation, "Pi request timed out.")),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      const trimmed = assistantText.trim();
      if (!trimmed) {
        return yield* failOperation(operation, "Pi agent returned empty output.");
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              failOperation(
                operation,
                "Pi agent returned invalid structured output.",
                cause,
              ),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : failOperation(operation, "Pi text generation failed.", cause),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  };
};
