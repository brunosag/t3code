import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ReadAloudScript from "./readAloudScript.ts";

const sonnet: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5-5",
};

/** Answers with `answers` in turn, logging each prompt and the start of writing. */
function write(answers: ReadonlyArray<string | TextGenerationError>, model: ModelSelection | null) {
  const log: string[] = [];
  let asked = 0;
  const layer = ReadAloudScript.layer.pipe(
    Layer.provide(
      Layer.succeed(TextGeneration.TextGeneration, {
        generateTranscriptionPostProcessing: (input: { prompt: string }) => {
          const answer = answers[asked++]!;
          log.push(input.prompt.includes("<reply>\n# Hi `x`\n</reply>") ? "asked" : "bad prompt");
          return typeof answer === "string"
            ? Effect.succeed({ transcription: answer })
            : Effect.fail(answer);
        },
      } as unknown as TextGeneration.TextGeneration["Service"]),
    ),
    Layer.provide(ServerSettings.layerTest({ readAloudModelSelection: model })),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const script = yield* ReadAloudScript.ReadAloudScript;
    return yield* script.write(
      "# Hi `x`",
      Effect.sync(() => log.push("writing")),
    );
  }).pipe(
    Effect.provide(layer),
    Effect.result,
    Effect.map((result) => ({
      result: result._tag === "Success" ? result.success : result.failure.message,
      log,
    })),
  );
}

describe("ReadAloudScript", () => {
  it.effect("asks nothing while no read aloud model is set", () =>
    Effect.gen(function* () {
      expect(yield* write([], null)).toEqual({ result: null, log: [] });
    }),
  );

  it.effect("asks again once when the script still has markdown or code in it", () =>
    Effect.gen(function* () {
      expect(yield* write(["Hi `x`.", "\n Hi x.\n"], sonnet)).toEqual({
        result: "Hi x.",
        log: ["writing", "asked", "asked"],
      });
      expect(yield* write(["# Hi x.", "Hi {x}.", "Hi x."], sonnet)).toEqual({
        result: 'The read aloud model answered twice with a script with "{" in "Hi {x}.".',
        log: ["writing", "asked", "asked"],
      });
      expect(yield* write(["  ", "  "], sonnet)).toMatchObject({
        result: expect.stringContaining("an empty script"),
      });
    }),
  );

  it.effect("fails with the provider's reason", () =>
    Effect.gen(function* () {
      const failure = new TextGenerationError({
        operation: "generateTranscriptionPostProcessing",
        detail: "Claude is rate limited.",
      });
      expect(yield* write([failure], sonnet)).toEqual({
        result: "Claude is rate limited.",
        log: ["writing", "asked"],
      });
    }),
  );
});
