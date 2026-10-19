// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  drafts: {} as Record<string, { text?: string; attachments?: unknown[] }>,
  uploads: {} as Record<string, unknown>,
  preparations: {} as Record<string, number>,
  requestId: "request-1",
  questionIds: ["first", "second"],
  multiSelect: false,
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "drafts"
      ? fixture.drafts
      : atom === "uploads"
        ? fixture.uploads
        : atom === questionAttachmentPreparationAtom
          ? fixture.preparations
          : appAtomRegistry.get(atom as never),
}));
vi.mock("./use-composer-drafts", () => ({
  composerDraftsAtom: "all-drafts",
  questionAttachmentDraftsAtom: () => "drafts",
  clearComposerDraft: vi.fn(),
  getComposerDraftSnapshot: (key: string) => fixture.drafts[key] ?? { text: "", attachments: [] },
  setQuestionDraftText: (key: string, text: string) => {
    fixture.drafts[key] = { ...fixture.drafts[key], text };
  },
  setComposerDraftText: (key: string, text: string) => {
    fixture.drafts[key] = { ...fixture.drafts[key], text };
  },
}));
vi.mock("./composer-attachment-uploads", async () => ({
  ...(await import("../lib/composerAttachmentUploadQueue")),
  composerAttachmentUploadsAtom: "uploads",
}));
vi.mock("./entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        "environment-1",
        {
          environment: {
            capabilities: {
              questionAttachments: true,
              attachmentUploads: true,
              fileAttachments: { maxUploadBytes: 20_000_000 },
            },
          },
        },
      ],
    ]),
}));
vi.mock("./session", () => ({ readEnvironmentScope: () => true }));
vi.mock("./threads", () => ({ threadEnvironment: {} }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment-1", id: "thread-1" },
  }),
}));
vi.mock("./use-thread-detail", () => ({
  useSelectedThreadPendingRequests: () => ({
    approvals: [],
    userInputs: [
      {
        requestId: fixture.requestId,
        createdAt: "2026-09-08T00:00:00Z",
        responseCapability: "live",
        dismissible: false,
        questions: fixture.questionIds.map((id) => ({
          id,
          header: id,
          question: `Attach ${id} file`,
          options: [
            { label: "Web", description: "Web" },
            { label: "Mobile", description: "Mobile" },
          ],
          allowCustomAnswer: true,
          multiSelect: fixture.multiSelect,
        })),
      },
    ],
  }),
}));

import { appAtomRegistry } from "./atom-registry";
import { ApprovalRequestId, RuntimeRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  questionAttachmentDraftKey,
  questionAttachmentPreparationAtom,
} from "./question-attachments";
import { useSelectedThreadRequests } from "./use-selected-thread-requests";

const environmentId = EnvironmentId.make("environment-1");
const key = (question: string) =>
  questionAttachmentDraftKey(
    environmentId,
    ThreadId.make("thread-1"),
    ApprovalRequestId.make("request-1"),
    question,
  );
function submitButtonMarkup() {
  function Probe() {
    const { activePendingUserInputAnswers } = useSelectedThreadRequests();
    return <button disabled={activePendingUserInputAnswers === null}>Submit answers</button>;
  }
  return renderToStaticMarkup(<Probe />);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.requestId = "request-1";
  fixture.questionIds = ["first", "second"];
  fixture.multiSelect = false;
  fixture.preparations = {};
  fixture.drafts = Object.fromEntries(
    ["first", "second"].map((id) => [
      key(id),
      {
        attachments: [
          {
            id,
            type: "file",
            name: `${id}.txt`,
            mimeType: "text/plain",
            sizeBytes: 4,
            fileUri: `file:///${id}.txt`,
          },
        ],
      },
    ]),
  );
  fixture.uploads = { "environment-1:first": { status: "ready" } };
});
describe("question attachment submission readiness", () => {
  it.each([
    undefined,
    { status: "uploading", progress: 0.5 },
    { status: "failed", reason: "Offline" },
  ])("keeps Submit disabled until all question uploads finish: %j", (state) => {
    if (state) fixture.uploads["environment-1:second"] = state;
    expect(submitButtonMarkup()).toContain("disabled");
    fixture.uploads["environment-1:second"] = { status: "ready" };
    expect(submitButtonMarkup()).not.toContain("disabled");
  });
  it("ignores an upload in another environment", () => {
    fixture.uploads["environment-1:second"] = { status: "ready" };
    fixture.uploads["environment-2:second"] = { status: "uploading", progress: 0.5 };
    expect(submitButtonMarkup()).not.toContain("disabled");
  });
  it("waits for attachment preparation even when uploads are ready", () => {
    fixture.uploads["environment-1:second"] = { status: "ready" };
    fixture.preparations[key("first")] = 1;
    expect(submitButtonMarkup()).toContain("disabled");
  });
});

describe("moving a mobile written answer to the thread draft", () => {
  it.each([false, true])(
    "moves restored text once across rapid taps (multiSelect=%s)",
    async (multiSelect) => {
      const requestId = RuntimeRequestId.make(`move-${multiSelect}`);
      fixture.requestId = requestId;
      fixture.questionIds = ["q"];
      fixture.multiSelect = multiSelect;
      const questionKey = questionAttachmentDraftKey(
        environmentId,
        ThreadId.make("thread-1"),
        requestId,
        "q",
      );
      const threadKey = "environment-1:thread-1";
      const image = { id: "image", type: "image" };
      fixture.uploads["environment-1:image"] = { status: "ready" };
      fixture.drafts[threadKey] = { text: "Existing draft" };
      fixture.drafts[questionKey] = { text: "Restored answer", attachments: [image] };
      const question = {
        id: "q",
        header: "Scope",
        question: "Choose",
        multiSelect,
        options: [
          { label: "Web", description: "Web" },
          { label: "Mobile", description: "Mobile" },
        ],
      };
      let requests: ReturnType<typeof useSelectedThreadRequests> | undefined;
      function Probe() {
        requests = useSelectedThreadRequests();
        return null;
      }
      const root = createRoot(document.createElement("div"));
      try {
        await act(async () => root.render(<Probe />));
        if (!requests) throw new Error("The request hook did not mount");
        const select = requests.onSelectUserInputOption;
        act(() => {
          select(requestId, question, "Web");
          select(requestId, question, "Mobile");
        });
        expect(fixture.drafts[threadKey]?.text).toBe("Existing draft\n\nRestored answer");
        expect(fixture.drafts[questionKey]).toEqual({ text: "", attachments: [image] });
        await act(async () => root.render(<Probe />));
        expect(requests?.activePendingUserInputAnswers).toEqual({
          q: multiSelect ? ["Web", "Mobile"] : "Mobile",
        });
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
});
