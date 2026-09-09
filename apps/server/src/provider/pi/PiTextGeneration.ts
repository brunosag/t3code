import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
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
import { PiRpcClient, type PiRpcClientOptions } from "./PiRpcClient.ts";
import { PiMessage, PiState, piMessageText, piModelSelection } from "./PiProtocol.ts";

const PI_TIMEOUT_MS = 180_000;
export type PiRpcClientInit = PiRpcClientOptions;
export type PiRpcClientLike = Pick<PiRpcClient, "request" | "send" | "close">;
export type PiRpcClientFactory = (
  init: PiRpcClientInit,
) => PiRpcClientLike | Promise<PiRpcClientLike>;
type Operation = keyof TextGeneration.TextGeneration["Service"];
const decodeMessage = Schema.decodeUnknownSync(PiMessage);
const decodeState = Schema.decodeUnknownSync(PiState);

/** Auxiliary prompts use the same external runtime, with no tool/resource/config overrides. */
export const makePiTextGeneration = (
  config: { binaryPath: string },
  environment: NodeJS.ProcessEnv = process.env,
  overrides: { createClient?: PiRpcClientFactory } = {},
): TextGeneration.TextGeneration["Service"] => {
  const createClient = overrides.createClient ?? ((init) => new PiRpcClient(init));
  const runPiJson = <S extends Schema.Top>(input: {
    operation: Operation;
    cwd: string;
    prompt: string;
    outputSchema: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const failure = (detail: string, cause?: unknown) =>
        new TextGenerationError({
          operation: input.operation,
          detail,
          ...(cause === undefined ? {} : { cause }),
        });
      const settled = yield* Deferred.make<void, TextGenerationError>();
      let assistantText = "";
      let lastError: string | undefined;
      let client: PiRpcClientLike | undefined;
      const fail = (detail: string) => {
        Deferred.doneUnsafe(settled, Effect.fail(failure(detail)));
      };
      const onEvent = (event: Record<string, unknown>) => {
        try {
          if (event.type === "message_end") {
            const message = decodeMessage(event.message);
            if (message.role !== "assistant") return;
            // Pi can recover errors through retry. Judge the final assistant outcome only.
            lastError =
              message.stopReason === "error" || message.stopReason === "aborted"
                ? message.errorMessage || `Pi request ${message.stopReason}.`
                : undefined;
            assistantText = piMessageText(message);
          } else if (event.type === "agent_settled") {
            if (lastError) fail(lastError);
            else Deferred.doneUnsafe(settled, Effect.void);
          } else if (
            event.type === "extension_ui_request" &&
            typeof event.id === "string" &&
            ["confirm", "select", "input", "editor"].includes(String(event.method))
          ) {
            // No UI is attached to an auxiliary title/commit request. Never grant consent.
            client?.send({ type: "extension_ui_response", id: event.id, cancelled: true });
            fail(
              "Pi requested interactive input during text generation. Run this action in a chat thread instead.",
            );
          }
        } catch (cause) {
          fail(`Invalid Pi RPC event: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      };
      client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            Promise.resolve(
              createClient({
                binaryPath: config.binaryPath,
                cwd: input.cwd,
                environment,
                onEvent,
                onExit: (error) => fail(error.message),
                requestTimeoutMs: PI_TIMEOUT_MS,
              }),
            ),
          catch: (cause) => failure("Failed to start Pi RPC client.", cause),
        }),
        (owned) => Effect.promise(() => owned.close()).pipe(Effect.ignore),
      );
      const owned = client;
      yield* Effect.tryPromise({
        try: async () => {
          decodeState(await owned.request("get_state"));
          const selection = piModelSelection(input.modelSelection.model);
          if (selection) await owned.request("set_model", selection);
          await owned.request("prompt", { message: input.prompt });
        },
        catch: (cause) => failure("Pi text generation request failed.", cause),
      });
      yield* Deferred.await(settled);
      if (!assistantText.trim()) return yield* failure("Pi agent returned empty output.");
      // The output schema varies by operation (title, commit, or pull request).
      // oxlint-disable-next-line t3code/no-inline-schema-compile
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
        extractJsonObject(assistantText.trim()),
      ).pipe(
        Effect.mapError((cause) => failure("Pi agent returned invalid structured output.", cause)),
      );
    }).pipe(
      Effect.timeoutOption(PI_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Pi request timed out.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.scoped,
    );

  return {
    generateCommitMessage: Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const prompt = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runPiJson({
        ...prompt,
        operation: "generateCommitMessage",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    }),
    generatePrContent: Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const prompt = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runPiJson({
        ...prompt,
        operation: "generatePrContent",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    }),
    generateBranchName: Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const prompt = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        ...prompt,
        operation: "generateBranchName",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    }),
    generateThreadTitle: Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const prompt = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        ...prompt,
        operation: "generateThreadTitle",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    }),
  };
};
