// @effect-diagnostics nodeBuiltinImport:off - materializes standalone extension files consumed by stock Pi.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

async function readExtension(path: string): Promise<string | undefined> {
  try {
    return await NodeFSP.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Materialize a content-addressed extension file that stock Pi can load with
 * `--extension`. The digest keeps a restarted server on the same path for the
 * same source, so Pi does not see a new extension on every boot.
 */
export async function materializePiExtension(input: {
  readonly stateDir: string;
  readonly filePrefix: string;
  readonly source: string;
}): Promise<string> {
  const directory = NodePath.join(input.stateDir, "pi");
  const digest = NodeCrypto.createHash("sha256").update(input.source).digest("hex").slice(0, 16);
  const extensionPath = NodePath.join(directory, `${input.filePrefix}${digest}.mjs`);
  await NodeFSP.mkdir(directory, { recursive: true });

  if ((await readExtension(extensionPath)) === input.source) {
    return extensionPath;
  }

  const temporaryPath = `${extensionPath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporaryPath, input.source, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    try {
      await NodeFSP.rename(temporaryPath, extensionPath);
    } catch (error) {
      // Windows does not replace an existing destination. A concurrent T3
      // writer is safe only when it installed the exact expected bytes.
      if (
        !["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") ||
        (await readExtension(extensionPath)) !== input.source
      ) {
        throw error;
      }
    }
    if ((await readExtension(extensionPath)) !== input.source) {
      throw new Error("Materialized Pi extension did not match its expected content.");
    }
    return extensionPath;
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true });
  }
}
