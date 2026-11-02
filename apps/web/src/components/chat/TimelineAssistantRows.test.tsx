import { MessageId } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type ChatMarkdown from "../ChatMarkdown";
import { AssistantTimelineRow } from "./TimelineAssistantRows";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";

const markdown = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock(import("../ChatMarkdown"), () => ({
  default: ((props: ComponentProps<typeof ChatMarkdown>) => {
    markdown.props.push(props as unknown as Record<string, unknown>);
    return null;
  }) as typeof ChatMarkdown,
}));
vi.mock(import("./AssistantCitationSource"), () => ({
  AssistantCitationSource: (({ children }: { children: ReactNode }) => children) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useAssistantMessageText: () => null,
}));

function row(id: string) {
  return {
    kind: "message",
    id: `entry-${id}`,
    message: { id: MessageId.make(id), role: "assistant", text: "![shot](/tmp/shot.png)" },
    showAssistantMeta: false,
    showAssistantTimestamp: false,
  } as unknown as Extract<TimelineRow, { kind: "message" }>;
}

describe("AssistantTimelineRow", () => {
  // Fork: a later message showing a file re-saved under the same path must mint a fresh URL.
  it("gives each message's markdown its own image revision", () => {
    markdown.props = [];
    const ctx = { threadRef: null, onOpenTurnDiff: undefined } as never;
    for (const id of ["first", "second"]) {
      renderToStaticMarkup(
        <TimelineRowCtx value={ctx}>
          <AssistantTimelineRow row={row(id)} />
        </TimelineRowCtx>,
      );
    }
    expect(markdown.props.map((props) => props.workspaceMutationId)).toEqual(["first", "second"]);
  });
});
