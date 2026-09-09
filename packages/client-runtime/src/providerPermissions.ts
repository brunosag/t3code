import type { ServerProvider } from "@t3tools/contracts";

/** Client wording for runtimes which own permission policy instead of T3. */
export function getProviderManagedPermissions(
  snapshot:
    | Pick<ServerProvider, "managesRuntimePermissions" | "displayName" | "driver">
    | undefined,
) {
  if (!snapshot?.managesRuntimePermissions) return undefined;
  const name = snapshot.displayName ?? snapshot.driver;
  return {
    label: `${name} managed`,
    description: `Permissions and tool behavior come from your ${name} runtime.`,
  };
}
