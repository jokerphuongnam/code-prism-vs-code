import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface PrismPlugin {
  id: string;
  name: string;
  bin: string;
  extensions: string[];
  markers: string[];
  cacheFolder: string;
  version: string;
  root: string;
  binaryPath: string;
}

interface Manifest {
  id: string;
  name: string;
  bin: string;
  extensions: string[];
  markers?: string[];
  cacheFolder?: string;
  version?: string;
}

function backendsCheckoutRoot(): string {
  return path.join(os.homedir(), "Documents", "Code", "code-prism", "backends");
}

function installedRoot(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "CodePrism",
    "backends"
  );
}

function tryLoad(dir: string): PrismPlugin | null {
  const manifestPath = path.join(dir, "code-prism-plugin.json");
  if (!fs.existsSync(manifestPath)) return null;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
  const cacheFolder =
    manifest.cacheFolder ||
    (manifest.id === "objc" ? "objective-c-prism" : `${manifest.id}-prism`);
  const candidates = [
    path.join(dir, "bin", manifest.bin),
    path.join(dir, manifest.bin),
    path.join(dir, "core", ".build", "release", manifest.bin),
    path.join(installedRoot(), manifest.id, manifest.bin),
  ];
  const binaryPath = candidates.find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return fs.existsSync(p);
    }
  }) || path.join(dir, "bin", manifest.bin);

  return {
    id: manifest.id,
    name: manifest.name,
    bin: manifest.bin,
    extensions: (manifest.extensions || []).map((e) => e.toLowerCase()),
    markers: manifest.markers || [],
    cacheFolder,
    version: manifest.version || "0",
    root: dir,
    binaryPath,
  };
}

/** Discover plugins from Application Support + code-prism/backends/*-prism. */
export function discoverPlugins(): PrismPlugin[] {
  const byId = new Map<string, PrismPlugin>();

  const scanInstalled = installedRoot();
  if (fs.existsSync(scanInstalled)) {
    for (const id of fs.readdirSync(scanInstalled)) {
      const plugin = tryLoad(path.join(scanInstalled, id));
      if (plugin) byId.set(plugin.id, plugin);
    }
  }

  const scanCheckouts = backendsCheckoutRoot();
  if (fs.existsSync(scanCheckouts)) {
    for (const repo of fs.readdirSync(scanCheckouts)) {
      if (!repo.endsWith("-prism")) continue;
      const plugin = tryLoad(path.join(scanCheckouts, repo));
      if (!plugin) continue;
      const existing = byId.get(plugin.id);
      if (!existing || fs.existsSync(plugin.binaryPath)) {
        byId.set(plugin.id, plugin);
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
