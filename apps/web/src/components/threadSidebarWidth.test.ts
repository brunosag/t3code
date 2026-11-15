import { describe, expect, it } from "vite-plus/test";

import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
} from "./threadSidebarWidth";

describe("thread sidebar width", () => {
  it("keeps a stored width through a narrow startup window", () => {
    const stored = resolveInitialThreadSidebarWidth(400);
    expect(clampThreadSidebarWidth(stored, 208, resolveThreadSidebarMaximumWidth(800))).toBe(208);
    expect(clampThreadSidebarWidth(stored, 208, resolveThreadSidebarMaximumWidth(1920))).toBe(400);
  });
});
