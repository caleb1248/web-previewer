import * as vscode from "vscode";

/**
 * Installs the packages listed in the workspace's package-lock.json into
 * node_modules, without npm: tarballs are fetched from the registry, unpacked in
 * memory and written through vscode.workspace.fs, so it also works in the web
 * extension host. Only what the bundler needs is done: no lifecycle scripts, no
 * .bin links, and no platform-specific (os/cpu) packages other than wasm32 ones.
 */

interface LockPackage {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  inBundle?: boolean;
  os?: string[];
  cpu?: string[];
}

interface Job {
  /** Lockfile key, which is also the install path relative to the root, e.g. "node_modules/react". */
  key: string;
  pkg: LockPackage;
  url: string;
}

const REGISTRY = "https://registry.npmjs.org";
const PACKAGE_CONCURRENCY = 6;
const WRITE_CONCURRENCY = 8;

export async function installDependencies(output: vscode.LogOutputChannel): Promise<void> {
  const root = await pickRoot();
  if (!root) {
    return;
  }

  let lock: { lockfileVersion?: number; packages?: Record<string, LockPackage> };
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, "package-lock.json"));
    lock = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    const missing = e instanceof vscode.FileSystemError && e.code === "FileNotFound";
    vscode.window.showErrorMessage(
      missing
        ? "JS Preview: no package-lock.json in the project root. Create one with `npm install --package-lock-only`."
        : `JS Preview: could not read package-lock.json: ${errorText(e)}`,
    );
    return;
  }
  if (!lock.packages) {
    vscode.window.showErrorMessage(
      "JS Preview: package-lock.json has no `packages` section (lockfileVersion 1). Regenerate it with npm 7 or later.",
    );
    return;
  }

  const jobs: Job[] = [];
  let skipped = 0;
  for (const [key, pkg] of Object.entries(lock.packages)) {
    // "" is the project itself; keys outside node_modules are workspace packages.
    if (!key.startsWith("node_modules/") || pkg.inBundle) {
      continue;
    }
    const url = tarballUrl(key, pkg);
    // Native binaries are no use to a browser preview; wasm builds are.
    const native = pkg.os || (pkg.cpu && !pkg.cpu.includes("wasm32"));
    if (pkg.link || native || !url) {
      output.info(`[install] skipping ${key}`);
      skipped++;
      continue;
    }
    jobs.push({ key, pkg, url });
  }

  const failures: string[] = [];
  let installed = 0;
  let upToDate = 0;
  const cancelled = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "JS Preview: installing dependencies",
      cancellable: true,
    },
    async (progress, token) => {
      let done = 0;
      await pool(jobs, PACKAGE_CONCURRENCY, async (job) => {
        if (token.isCancellationRequested) {
          return;
        }
        try {
          if (await installPackage(root, job)) {
            installed++;
          } else {
            upToDate++;
          }
        } catch (e) {
          failures.push(job.key);
          output.error(`[install] ${job.key}: ${errorText(e)}`);
        }
        done++;
        progress.report({
          increment: 100 / jobs.length,
          message: `${done}/${jobs.length}`,
        });
      });
      return token.isCancellationRequested;
    },
  );

  const summary =
    `${installed} installed, ${upToDate} already up to date` +
    (skipped ? `, ${skipped} skipped` : "") +
    (failures.length ? `, ${failures.length} failed` : "");
  output.info(`[install] ${cancelled ? "cancelled: " : ""}${summary}`);
  if (failures.length) {
    const choice = await vscode.window.showErrorMessage(
      `JS Preview: ${summary}. First failure: ${failures[0]}`,
      "Show Log",
    );
    if (choice) {
      output.show();
    }
  } else if (cancelled) {
    vscode.window.showWarningMessage(`JS Preview: install cancelled (${summary}).`);
  } else {
    vscode.window.showInformationMessage(`JS Preview: ${summary}.`);
  }
  if (installed > 0) {
    void vscode.commands.executeCommand("js-preview.refreshPreview");
  }
}

async function pickRoot(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    vscode.window.showErrorMessage("JS Preview: open a folder to install its dependencies.");
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri;
  }
  return (await vscode.window.showWorkspaceFolderPick())?.uri;
}

/** The tarball to download, or undefined for sources that aren't registry tarballs (git, file:). */
function tarballUrl(key: string, pkg: LockPackage): string | undefined {
  if (pkg.resolved) {
    return /^https?:\/\//.test(pkg.resolved) ? pkg.resolved : undefined;
  }
  if (!pkg.version) {
    return undefined;
  }
  // Lockfiles written with `omit-lockfile-registry-resolved` have no URL.
  const name = pkg.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  return `${REGISTRY}/${name}/-/${name.split("/").pop()}-${pkg.version}.tgz`;
}

/** Returns false if the locked version was already installed. */
async function installPackage(root: vscode.Uri, { key, pkg, url }: Job): Promise<boolean> {
  const dir = vscode.Uri.joinPath(root, key);
  if (pkg.version && (await installedVersion(dir)) === pkg.version) {
    return false;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const tgz = await response.arrayBuffer();
  if (pkg.integrity) {
    await verifyIntegrity(tgz, pkg.integrity);
  }
  const tar = new Uint8Array(
    await new Response(
      new Blob([tgz]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer(),
  );

  await clearPackageDir(dir);
  let packageJson: Uint8Array | undefined;
  const files: { uri: vscode.Uri; data: Uint8Array }[] = [];
  for (const file of untar(tar)) {
    // Every path starts with one wrapper folder (usually "package/").
    const segments = file.path.split("/").slice(1).filter((s) => s && s !== ".");
    if (segments.length === 0 || segments.includes("..")) {
      continue;
    }
    if (segments.length === 1 && segments[0] === "package.json") {
      packageJson = file.data;
    } else {
      files.push({ uri: vscode.Uri.joinPath(dir, ...segments), data: file.data });
    }
  }
  // writeFile creates missing parent directories.
  await pool(files, WRITE_CONCURRENCY, (f) => vscode.workspace.fs.writeFile(f.uri, f.data));
  // Written last: it marks the package as completely installed (see installedVersion).
  if (packageJson) {
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, "package.json"), packageJson);
  }
  return true;
}

async function installedVersion(dir: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, "package.json"));
    const version = (JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Removes another version's files, keeping nested node_modules (those are separate lockfile entries). */
async function clearPackageDir(dir: vscode.Uri): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [name] of entries) {
    if (name !== "node_modules") {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name), { recursive: true });
    }
  }
}

/** Checks a tarball against an SRI string like "sha512-<base64>". */
async function verifyIntegrity(data: ArrayBuffer, integrity: string): Promise<void> {
  const hashes = integrity.split(/\s+/);
  const hash =
    hashes.find((h) => h.startsWith("sha512-")) ?? hashes.find((h) => h.startsWith("sha1-"));
  if (!hash) {
    return;
  }
  const dash = hash.indexOf("-");
  const algorithm = hash.startsWith("sha512") ? "SHA-512" : "SHA-1";
  const digest = new Uint8Array(await crypto.subtle.digest(algorithm, data));
  let binary = "";
  for (const byte of digest) {
    binary += String.fromCharCode(byte);
  }
  if (btoa(binary) !== hash.slice(dash + 1).split("?")[0]) {
    throw new Error("integrity check failed");
  }
}

/** Yields the regular files of a tar archive (ustar, with pax and GNU long names). */
function* untar(data: Uint8Array): Generator<{ path: string; data: Uint8Array }> {
  const decoder = new TextDecoder();
  const text = (start: number, length: number) => {
    const field = data.subarray(start, start + length);
    const end = field.indexOf(0);
    return decoder.decode(end === -1 ? field : field.subarray(0, end));
  };
  let offset = 0;
  let longName: string | undefined;
  // The archive ends with zero-filled blocks.
  while (offset + 512 <= data.length && data[offset] !== 0) {
    const header = offset;
    const size = parseInt(text(header + 124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(data[header + 156] || 48);
    const body = data.subarray(header + 512, header + 512 + size);
    offset = header + 512 + Math.ceil(size / 512) * 512;

    if (type === "x") {
      // pax header for the next entry: records of "<length> <key>=<value>\n".
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(decoder.decode(body));
      longName = path?.[1] ?? longName;
    } else if (type === "L") {
      longName = decoder.decode(body).replace(/\0+$/, "");
    } else if (type !== "g") {
      const prefix = text(header + 345, 155);
      const name = text(header, 100);
      const path = longName ?? (prefix ? `${prefix}/${name}` : name);
      longName = undefined;
      if (type === "0") {
        yield { path, data: body };
      }
    }
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Thenable<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
