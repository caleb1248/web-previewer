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

  let packages: Record<string, LockPackage>;
  try {
    const npmLock = await readOptional(vscode.Uri.joinPath(root, "package-lock.json"));
    const bunLock =
      npmLock === undefined ? await readOptional(vscode.Uri.joinPath(root, "bun.lock")) : undefined;
    if (npmLock !== undefined) {
      const lock = JSON.parse(npmLock) as { packages?: Record<string, LockPackage> };
      if (!lock.packages) {
        throw new Error(
          "package-lock.json has no `packages` section (lockfileVersion 1). Regenerate it with npm 7 or later.",
        );
      }
      packages = lock.packages;
    } else if (bunLock !== undefined) {
      packages = packagesFromBunLock(bunLock);
    } else {
      throw new Error(
        "no package-lock.json or bun.lock in the project root. Create one with `npm install --package-lock-only` or `bun install --lockfile-only`.",
      );
    }
  } catch (e) {
    vscode.window.showErrorMessage(`JS Preview: ${errorText(e)}`);
    return;
  }

  const jobs: Job[] = [];
  let skipped = 0;
  for (const [key, pkg] of Object.entries(packages)) {
    // "" is the project itself; keys outside node_modules are workspace packages.
    if (!key.startsWith("node_modules/") || pkg.inBundle) {
      continue;
    }
    const url = tarballUrl(key, pkg);
    // Native binaries are no use to a browser preview; wasm builds are.
    // bun.lock records a cpu bun doesn't know, such as wasm32, as "none".
    const native =
      pkg.os || (pkg.cpu && !pkg.cpu.includes("wasm32") && !pkg.cpu.includes("none"));
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
      // Packages being installed right now, in the order they were started.
      const active = new Set<string>();
      const message = () =>
        `${done}/${jobs.length}: ${[...active].map((key) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length)).join(", ")}`;
      await pool(jobs, PACKAGE_CONCURRENCY, async (job) => {
        if (token.isCancellationRequested) {
          return;
        }
        active.add(job.key);
        progress.report({ message: message() });
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
        active.delete(job.key);
        // Every report carries the message: VS Code batches reports and shows only
        // the last one's message, so an increment-only report would blank it.
        progress.report({ increment: 100 / jobs.length, message: message() });
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

/** The file's text, or undefined if it doesn't exist. */
async function readOptional(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (e) {
    if (e instanceof vscode.FileSystemError && e.code === "FileNotFound") {
      return undefined;
    }
    throw e;
  }
}

/**
 * Converts bun.lock's `packages` into package-lock.json's shape. Keys are
 * dependency paths ("parent/child" is child nested under parent), and values are
 * tuples: `["name@version", registry, { os, cpu, ... }, integrity]` for registry
 * packages, `["name@https://...tgz", { ... }, integrity]` for tarball URLs. Other
 * sources (workspace, git, file) come out without a URL and are skipped.
 */
function packagesFromBunLock(text: string): Record<string, LockPackage> {
  // bun.lock is JSON with trailing commas.
  const json = text.replace(
    /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
    (_m, str: string | undefined, tail: string) => str ?? tail,
  );
  const lock = JSON.parse(json) as { packages?: Record<string, unknown[]> };
  if (!lock.packages) {
    throw new Error("bun.lock has no `packages` section.");
  }
  const list = (value: unknown): string[] | undefined =>
    value === undefined ? undefined : ([] as unknown[]).concat(value).map(String);

  const packages: Record<string, LockPackage> = {};
  for (const [key, entry] of Object.entries(lock.packages)) {
    const id = String(entry[0]);
    const at = id.indexOf("@", 1);
    const name = id.slice(0, at);
    const spec = id.slice(at + 1);
    const meta = entry.find((e) => typeof e === "object" && e !== null) as
      | { os?: unknown; cpu?: unknown }
      | undefined;
    const integrity = entry.find((e) => typeof e === "string" && /^sha\d+-/.test(e));
    const pkg: LockPackage = {
      name,
      integrity: integrity as string | undefined,
      os: list(meta?.os),
      cpu: list(meta?.cpu),
    };
    if (/^https?:\/\//.test(spec)) {
      pkg.resolved = spec;
    } else if (/^\d/.test(spec) && typeof entry[1] === "string") {
      pkg.version = spec;
      const registry = entry[1];
      pkg.resolved = registry.endsWith(".tgz")
        ? registry
        : `${(registry || REGISTRY).replace(/\/$/, "")}/${name}/-/${name.split("/").pop()}-${spec}.tgz`;
    } else {
      pkg.resolved = spec; // not a registry tarball; skipped by tarballUrl
    }

    // "a/@s/b/c" -> "node_modules/a/node_modules/@s/b/node_modules/c"
    const names = key.match(/(@[^/]+\/)?[^/]+/g) ?? [];
    packages[names.map((n) => `node_modules/${n}`).join("/")] = pkg;
  }
  return packages;
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
