// @effect-diagnostics preferSchemaOverJson:off - Fixed RPC fixture payloads.
import { describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import {
  makePiTextGeneration,
  type PiRpcClientFactory,
  type PiRpcClientInit,
  type PiRpcClientLike,
} from "./PiTextGeneration.ts";

interface RecordedRequest {
  readonly type: string;
  readonly fields: Record<string, unknown> | undefined;
}

type PromptBehavior =
  | { readonly kind: "succeed"; readonly text: string | null }
  | { readonly kind: "errorEvent"; readonly message: string }
  | { readonly kind: "aborted" }
  | { readonly kind: "promptRejected"; readonly message: string };

interface FakeHarness {
  readonly factory: PiRpcClientFactory;
  readonly clients: Array<FakePiRpcClient>;
  readonly requests: Array<RecordedRequest>;
}

class FakePiRpcClient implements PiRpcClientLike {
  readonly requests: Array<RecordedRequest> = [];
  closed = false;
  private readonly init: PiRpcClientInit;
  private readonly behavior: PromptBehavior;
  private readonly shared: Array<RecordedRequest>;

  constructor(init: PiRpcClientInit, behavior: PromptBehavior, shared: Array<RecordedRequest>) {
    this.init = init;
    this.behavior = behavior;
    this.shared = shared;
  }

  send(): void {}

  async request(type: string, fields?: Record<string, unknown>): Promise<unknown> {
    const recorded = { type, fields };
    this.requests.push(recorded);
    this.shared.push(recorded);
    if (type === "get_state") return { sessionId: "fixture", isStreaming: false };
    if (type === "set_model") {
      return { ok: true };
    }
    if (type !== "prompt") {
      throw new Error(`unexpected Pi RPC request: ${type}`);
    }
    const behavior = this.behavior;
    if (behavior.kind === "promptRejected") {
      throw new Error(behavior.message);
    }
    queueMicrotask(() => {
      if (behavior.kind === "errorEvent") {
        this.init.onEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: behavior.message,
          },
        });
        this.init.onEvent({ type: "agent_settled" });
        return;
      }
      if (behavior.kind === "aborted") {
        this.init.onEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ title: "Discarded title" }) }],
            stopReason: "aborted",
          },
        });
        this.init.onEvent({ type: "agent_settled", reason: "aborted" });
        return;
      }
      if (behavior.text !== null) {
        this.init.onEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: behavior.text }],
            stopReason: "stop",
          },
        });
      }
      this.init.onEvent({ type: "agent_settled", reason: "completed" });
    });
    return { ok: true };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeHarness(behavior: PromptBehavior): FakeHarness {
  const clients: Array<FakePiRpcClient> = [];
  const requests: Array<RecordedRequest> = [];
  const factory: PiRpcClientFactory = (init) => {
    const client = new FakePiRpcClient(init, behavior, requests);
    clients.push(client);
    return client;
  };
  return { factory, clients, requests };
}

const piInstance = ProviderInstanceId.make("pi");

describe("PiTextGeneration", () => {
  it.effect("generates a thread title from message_end assistant text", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        kind: "succeed",
        text: JSON.stringify({ title: "Investigate failing CI" }),
      });
      const textGeneration = makePiTextGeneration(
        { binaryPath: "/bin/pi" },
        {},
        {
          createClient: harness.factory,
        },
      );

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "the lint job is red",
        modelSelection: createModelSelection(piInstance, "default"),
      });

      expect(generated.title).toBe("Investigate failing CI");
      expect(harness.requests.map((request) => request.type)).toEqual(["get_state", "prompt"]);
      expect(harness.requests[1]?.fields).toMatchObject({
        message: expect.stringContaining("the lint job is red") as unknown,
      });
      expect(harness.clients).toHaveLength(1);
      expect(harness.clients[0]?.closed).toBe(true);
    }),
  );

  it.effect("extracts the JSON object when Pi wraps it in conversational text", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        kind: "succeed",
        text:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
      });
      const textGeneration = makePiTextGeneration(
        { binaryPath: "/bin/pi" },
        {},
        {
          createClient: harness.factory,
        },
      );

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "the lint job is red",
        modelSelection: createModelSelection(piInstance, "default"),
      });

      expect(generated.title).toBe("Investigate failing CI");
    }),
  );

  it.effect("splits provider/modelId on the first slash for set_model", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        kind: "succeed",
        text: JSON.stringify({ branch: "fix/ci-flake" }),
      });
      const textGeneration = makePiTextGeneration(
        { binaryPath: "/bin/pi" },
        {},
        {
          createClient: harness.factory,
        },
      );

      const generated = yield* textGeneration.generateBranchName({
        cwd: process.cwd(),
        message: "fix the flaky test",
        modelSelection: createModelSelection(piInstance, "acme/text-pro/v2"),
      });

      expect(generated.branch).toBe("fix/ci-flake");
      expect(harness.requests.map((request) => request.type)).toEqual([
        "get_state",
        "set_model",
        "prompt",
      ]);
      expect(harness.requests[1]?.fields).toEqual({
        provider: "acme",
        modelId: "text-pro/v2",
      });
    }),
  );

  it.effect("rejects model selections without the provider/model format", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        kind: "succeed",
        text: JSON.stringify({ branch: "fix/ci-flake" }),
      });
      const textGeneration = makePiTextGeneration(
        { binaryPath: "/bin/pi" },
        {},
        {
          createClient: harness.factory,
        },
      );

      const error = yield* Effect.flip(
        textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "fix the flaky test",
          modelSelection: createModelSelection(piInstance, "justamodel"),
        }),
      );

      expect(error._tag).toBe("TextGenerationError");
      expect(String(error.cause)).toContain("provider/model");
      expect(harness.clients[0]?.closed).toBe(true);
    }),
  );

  it.effect("fails and closes when the agent reports an error event", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ kind: "errorEvent", message: "model overloaded" });
      const textGeneration = makePiTextGeneration(
        { binaryPath: "/bin/pi" },
        {},
        {
          createClient: harness.factory,
        },
      );

      const error = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(piInstance, "default"),
        }),
      );

      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toContain("model overloaded");
      expect(harness.clients[0]?.closed).toBe(true);
    }),
  );

  it.effect("fails when settlement reports aborted", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ kind: "aborted" });
      const textGeneration = makePiTextGeneration(
        { binaryPath: "/bin/pi" },
        {},
        {
          createClient: harness.factory,
        },
      );

      const error = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(piInstance, "default"),
        }),
      );

      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toMatch(/abort/i);
      expect(harness.clients[0]?.closed).toBe(true);
    }),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ kind: "succeed", text: null });
      const textGeneration = makePiTextGeneration(
        { binaryPath: "/bin/pi" },
        {},
        {
          createClient: harness.factory,
        },
      );

      const error = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(piInstance, "default"),
        }),
      );

      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toMatch(/empty/i);
    }),
  );

  it.effect("fails with TextGenerationError when output is unparseable JSON", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        kind: "succeed",
        text: "totally not json output from a confused model",
      });
      const textGeneration = makePiTextGeneration(
        { binaryPath: "/bin/pi" },
        {},
        {
          createClient: harness.factory,
        },
      );

      const error = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(piInstance, "default"),
        }),
      );

      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toMatch(/invalid structured output/i);
    }),
  );

  it.effect("generates and sanitizes commit messages with a branch", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        kind: "succeed",
        text: JSON.stringify({
          subject: "Add pi provider with too much detail and a trailing period.",
          body: "\n- wire up the RPC runtime\n",
          branch: "Add Pi Provider!!",
        }),
      });
      const textGeneration = makePiTextGeneration(
        { binaryPath: "/bin/pi" },
        {},
        {
          createClient: harness.factory,
        },
      );

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/pi",
        stagedSummary: "M apps/server/src/provider/pi/PiTextGeneration.ts",
        stagedPatch: "diff --git a/.../PiTextGeneration.ts b/.../PiTextGeneration.ts",
        includeBranch: true,
        modelSelection: createModelSelection(piInstance, "default"),
      });

      expect(generated.subject.endsWith(".")).toBe(false);
      expect(generated.subject.length).toBeLessThanOrEqual(72);
      expect(generated.body).toBe("- wire up the RPC runtime");
      expect(generated.branch).toBeDefined();
    }),
  );

  it.effect("surfaces prompt request rejections as text generation errors", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        kind: "promptRejected",
        message: "connection reset",
      });
      const textGeneration = makePiTextGeneration(
        { binaryPath: "/bin/pi" },
        {},
        {
          createClient: harness.factory,
        },
      );

      const error = yield* Effect.flip(
        textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feat/pi",
          commitSummary: "feat: add pi provider",
          diffSummary: "M PiTextGeneration.ts",
          diffPatch: "diff --git a/PiTextGeneration.ts b/PiTextGeneration.ts",
          modelSelection: createModelSelection(piInstance, "default"),
        }),
      );

      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toContain("request failed");
      expect(harness.clients[0]?.closed).toBe(true);
    }),
  );
});
