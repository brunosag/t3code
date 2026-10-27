import { describe, expect, it } from "@effect/vitest";

import { memoryHeadroom } from "./memory-headroom.ts";

const GiB = 1024 ** 3;

const files = (entries: Record<string, string>) => (path: string) => {
  const content = entries[path];
  if (content === undefined) throw new Error(`ENOENT: ${path}`);
  return content;
};

describe("memoryHeadroom", () => {
  it("takes the tightest limit above the process", () => {
    const readFile = files({
      "/proc/self/cgroup": "0::/user.slice/agents.slice/agent.scope\n",
      "/sys/fs/cgroup/user.slice/agents.slice/agent.scope/memory.current": `${GiB}`,
      "/sys/fs/cgroup/user.slice/agents.slice/agent.scope/memory.high": "max",
      "/sys/fs/cgroup/user.slice/agents.slice/agent.scope/memory.max": "max",
      "/sys/fs/cgroup/user.slice/agents.slice/memory.current": `${3 * GiB}`,
      "/sys/fs/cgroup/user.slice/agents.slice/memory.max": `${5 * GiB}`,
      "/sys/fs/cgroup/user.slice/memory.current": `${7 * GiB}`,
      "/sys/fs/cgroup/user.slice/memory.high": `${8 * GiB}`,
      "/sys/fs/cgroup/user.slice/memory.max": `${9 * GiB}`,
    });
    expect(memoryHeadroom({ available: 4 * GiB, platform: "linux", readFile })).toBe(GiB);
    expect(
      memoryHeadroom({
        available: 4 * GiB,
        platform: "linux",
        readFile: files({ "/proc/self/cgroup": "0::/\n" }),
      }),
    ).toBe(4 * GiB);
  });

  it("reports no room when Linux hides the process's cgroup", () => {
    expect(memoryHeadroom({ available: 64 * GiB, platform: "linux", readFile: files({}) })).toBe(0);
    expect(memoryHeadroom({ available: 64 * GiB, platform: "darwin", readFile: files({}) })).toBe(
      64 * GiB,
    );
  });
});
