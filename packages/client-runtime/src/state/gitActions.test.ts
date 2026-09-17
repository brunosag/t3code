import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  buildMenuItems,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
} from "./gitActions.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("changeRequestActionMode", () => {
  it("auto keeps change request creation in the primary action", () => {
    const quick = resolveQuickAction(status({ hasWorkingTreeChanges: true }), false, false, true, {
      changeRequestActionMode: "auto",
    });
    expect(quick).toMatchObject({ kind: "run_action", action: "commit_push_pr" });
  });

  it("manual leaves creation to the menu", () => {
    const quick = resolveQuickAction(status({ hasWorkingTreeChanges: true }), false, false, true, {
      changeRequestActionMode: "manual",
    });
    expect(quick).toMatchObject({ kind: "run_action", action: "commit_push" });

    const items = buildMenuItems(status({ hasWorkingTreeChanges: true }), false, true, {
      changeRequestActionMode: "manual",
    });
    expect(items.find((item) => item.id === "pr")).toMatchObject({
      kind: "open_dialog",
      dialogAction: "create_pr",
    });
  });

  it("off removes creation from the primary action and the menu", () => {
    const quick = resolveQuickAction(status({ aheadCount: 1 }), false, false, true, {
      changeRequestActionMode: "off",
    });
    expect(quick).toMatchObject({ kind: "run_action", action: "push" });

    const items = buildMenuItems(status({ aheadCount: 1 }), false, true, {
      changeRequestActionMode: "off",
    });
    expect(items.some((item) => item.id === "pr")).toBe(false);
  });

  it("off keeps an already-open change request viewable", () => {
    const items = buildMenuItems(
      status({
        pr: {
          number: 4,
          title: "Existing PR",
          url: "https://example.com/pr/4",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
      true,
      { changeRequestActionMode: "off" },
    );
    expect(items.find((item) => item.id === "pr")).toMatchObject({ kind: "open_pr" });
  });
});

describe("confirmPushToDefaultBranch", () => {
  it("prompts on the default ref by default", () => {
    expect(requiresDefaultBranchConfirmation("commit_push", true)).toBe(true);
    expect(
      requiresDefaultBranchConfirmation("commit_push", true, {
        confirmPushToDefaultBranch: true,
      }),
    ).toBe(true);
  });

  it("skips the prompt when the user disabled it", () => {
    expect(
      requiresDefaultBranchConfirmation("commit_push", true, {
        confirmPushToDefaultBranch: false,
      }),
    ).toBe(false);
    expect(
      requiresDefaultBranchConfirmation("push", true, { confirmPushToDefaultBranch: false }),
    ).toBe(false);
  });
});
