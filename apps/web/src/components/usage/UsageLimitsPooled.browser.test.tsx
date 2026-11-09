import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceAccount,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const state = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      setUsageLimitSourceAccountDisabled: {
        ...actual.serverEnvironment.setUsageLimitSourceAccountDisabled,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

function hubLogin(
  id: string,
  options: { readonly name: string; readonly disabled?: boolean },
): UsageLimitSourceAccount {
  return {
    id,
    driver: ProviderDriverKind.make("claudeAgent"),
    name: options.name,
    plan: "Claude Max 5x",
    capacity: 5,
    priority: 0,
    ...(options.disabled ? { disabled: true } : {}),
    usageLimits: options.disabled
      ? { checkedAt, windows: [], unavailable: { reason: "unsupported" } }
      : {
          checkedAt,
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 40,
              resetsAt: "2026-10-25T18:00:00.000Z",
              windowDurationMins: 300,
            },
          ],
        },
  };
}

function hubPresentations(accounts: readonly UsageLimitSourceAccount[]) {
  return new Map([
    [
      EnvironmentId.make("desk"),
      {
        entry: { target: { label: "Desk" } },
        serverConfig: {
          providers: [],
          usageLimitSources: [
            {
              id: UsageLimitSourceId.make("hub"),
              kind: "cliproxy" as const,
              label: "Hub",
              checkedAt,
              accounts,
            },
          ],
        },
      },
    ],
  ]);
}

describe("UsageLimitsPooled hub accounts", () => {
  it("keeps a provider whose hub logins are all off so one can be turned back on", async () => {
    state.run.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    const presentations = hubPresentations([
      hubLogin("team.json", { name: "Team", disabled: true }),
    ]);
    await using screen = await render(
      <UsageLimitsPooled
        presentations={presentations}
        now={Date.parse(checkedAt)}
        onProviderOrderChange={() => {}}
        onHideProvider={() => {}}
        onHiddenLimitsChange={() => {}}
        onHiddenAccountRowsChange={() => {}}
      />,
    );

    await expect.element(screen.getByText("Every hub account is off.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Claude limit actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Hub accounts" }));
    const team = page.getByRole("menuitemcheckbox", { name: "Team" });
    await expect.element(team).not.toBeChecked();
    await userEvent.click(team);
    expect(state.run).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("desk"),
      input: { sourceId: UsageLimitSourceId.make("hub"), accountId: "team.json", disabled: false },
    });
    await expect.element(team).toBeChecked();
  });
});
