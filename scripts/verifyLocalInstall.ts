/** Dev handoff gate: after `npm run dev:sync`, confirms global `guru` resolves to this checkout (see `package.json` `dev:sync`). */
import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const npmRootCommand = process.platform === "win32" ? "npm.cmd root -g" : "npm root -g";
const sourceRoot = realpathSync(resolve(process.cwd()));

let globalNodeModules: string;
try {
  globalNodeModules = execSync(npmRootCommand, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
} catch {
  throw new Error("Could not locate npm's global package directory.");
}

const installedPackage = join(globalNodeModules, "guruharness");
if (!existsSync(installedPackage)) {
  throw new Error(`Global Guru package was not created at ${installedPackage}.`);
}

const resolvedInstall = realpathSync(installedPackage);
const normalize = (path: string) =>
  process.platform === "win32" ? path.toLowerCase() : path;

if (normalize(resolvedInstall) !== normalize(sourceRoot)) {
  throw new Error(
    `Global guru resolves to ${resolvedInstall}, not this checkout (${sourceRoot}).`,
  );
}

if (!existsSync(join(resolvedInstall, "dist", "guru.js"))) {
  throw new Error("The linked checkout has no built dist/guru.js entry point.");
}

console.log(`Local Guru install is linked to ${resolvedInstall}.`);
