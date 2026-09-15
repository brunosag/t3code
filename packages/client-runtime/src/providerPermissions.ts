import type { ServerProvider } from "@t3tools/contracts";

/**
 * Whether the runtime owns permission policy instead of T3. Clients hide T3's
 * runtime-mode selector for these providers rather than presenting choices the
 * runtime does not honor.
 */
export function providerManagesRuntimePermissions(
  snapshot: Pick<ServerProvider, "managesRuntimePermissions"> | undefined,
): boolean {
  return snapshot?.managesRuntimePermissions === true;
}
