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
  | { readonly kind: "promptRejected"; readonly message: string }
  | { readonly kind: "interactive"; readonly method: string; readonly id?: string }
  | { readonly kind: "errorThenRetry"; readonly errorMessage: string; readonly text: string }
  | {
      readonly kind: "successThenError";
      readonly text: string;
      readonly errorMessage: string;
    }
  | { readonly kind: "ignoredUi"; readonly method: string; readonly text: string };

interface FakeHarness {
  readonly factory: PiRpcClientFactory;
  readonly clients: Array<FakePiRpcClient>;
  readonly requests: Array<RecordedRequest>;
}

class FakePiRpcClient implements PiRpcClientLike {
  readonly requests: Array<RecordedRequest> = [];
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  private readonly init: PiRpcClientInit;
  private readonly behavior: PromptBehavior;
  private readonly shared: Array<RecordedRequest>;

  constructor(init: PiRpcClientInit, behavior: PromptBehavior, shared: Array<RecordedRequest>) {
    this.init = init;
    this.behavior = behavior;
    this.shared = shared;
  }

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
  }

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
      if (behavior.kind === "interactive") {
        this.init.onEvent({
          type: "extension_ui_request",
          id: behavior.id ?? "ui-1",
          method: behavior.method,
        });
        this.init.onEvent({ type: "agent_settled", reason: "completed" });
        return;
      }
      if (behavior.kind === "errorThenRetry") {
        this.init.onEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: behavior.errorMessage,
          },
        });
        this.init.onEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: behavior.text }],
            stopReason: "stop",
          },
        });
        this.init.onEvent({ type: "agent_settled", reason: "completed" });
        return;
      }
      if (behavior.kind === "successThenError") {
        this.init.onEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: behavior.text }],
            stopReason: "stop",
          },
        });
        this.init.onEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: behavior.errorMessage,
          },
        });
        this.init.onEvent({ type: "agent_settled" });
        return;
      }
      if (behavior.kind === "ignoredUi") {
        this.init.onEvent({
          type: "extension_ui_request",
          id: "ui-ignored",
          method: behavior.method,
        });
        this.init.onEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: behavior.text }],
            stopReason: "stop",
          },
        });
        this.init.onEvent({ type: "agent_settled", reason: "completed" });
        return;
      }
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

  it.effect("cancels an interactive confirm dialog and closes the client", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ kind: "interactive", method: "confirm", id: "ui-42" });
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
      expect(error.detail).toMatch(/interactive input/i);
      expect(harness.clients[0]?.sent).toEqual([
        { type: "extension_ui_response", id: "ui-42", cancelled: true },
      ]);
      expect(harness.clients[0]?.closed).toBe(true);
    }),
  );

  it.effect("recovers when Pi retries after a transient error before agent_settled", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        kind: "errorThenRetry",
        errorMessage: "transient model overloaded",
        text: JSON.stringify({ title: "Recovered title" }),
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
        message: "anything",
        modelSelection: createModelSelection(piInstance, "default"),
      });

      expect(generated.title).toBe("Recovered title");
      expect(harness.clients[0]?.closed).toBe(true);
    }),
  );

  it.effect("fails when the final retry ends in error after an earlier success", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        kind: "successThenError",
        text: JSON.stringify({ title: "Stale title" }),
        errorMessage: "final retry failed",
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
      expect(error.detail).toContain("final retry failed");
      expect(harness.clients[0]?.closed).toBe(true);
    }),
  );

  it.effect("ignores non-interactive extension UI requests", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        kind: "ignoredUi",
        method: "notify",
        text: JSON.stringify({ title: "Ordinary title" }),
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
        message: "anything",
        modelSelection: createModelSelection(piInstance, "default"),
      });

      expect(generated.title).toBe("Ordinary title");
      expect(harness.clients[0]?.sent).toEqual([]);
      expect(harness.clients[0]?.closed).toBe(true);
    }),
  );
});
