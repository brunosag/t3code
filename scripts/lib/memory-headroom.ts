// @effect-diagnostics nodeBuiltinImport:off -- reads /proc and /sys/fs/cgroup.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * The least room left under `available` and every limited cgroup above the
 * process in `selfCgroup` (/proc/self/cgroup). An unreadable cgroup counts as
 * no room, so callers fall back to their frugal path.
 */
export function memoryHeadroom({
  available = NodeOS.freemem(),
  platform,
  readFile = (path: string) => NodeFS.readFileSync(path, "utf8"),
}: {
  readonly available?: number;
  readonly platform: NodeJS.Platform;
  readonly readFile?: (path: string) => string;
}): number {
  if (platform !== "linux") return available;
  const read = (path: string) => {
    try {
      return readFile(path).trim();
    } catch {
      return undefined;
    }
  };
  const own = read("/proc/self/cgroup")?.match(/^0::(\/.*)$/m)?.[1];
  if (own === undefined) return 0;
  let headroom = available;
  for (
    let dir = NodePath.posix.join("/sys/fs/cgroup", own).replace(/\/$/, "");
    dir.startsWith("/sys/fs/cgroup/");
    dir = NodePath.posix.dirname(dir)
  ) {
    const current = Number(read(`${dir}/memory.current`) ?? 0);
    for (const limit of [read(`${dir}/memory.high`), read(`${dir}/memory.max`)]) {
      if (limit !== undefined && limit !== "max") {
        headroom = Math.min(headroom, Number(limit) - current);
      }
    }
  }
  return Number.isNaN(headroom) ? 0 : Math.max(headroom, 0);
}
