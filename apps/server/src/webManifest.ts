/** Names an installed web app after its environment so apps from several hosts stay apart. */
export const labelWebManifest = (manifest: string, label: string): string => {
  const name = `T3 Code (${label})`;
  return JSON.stringify({ ...JSON.parse(manifest), name, short_name: name }, null, 2);
};
