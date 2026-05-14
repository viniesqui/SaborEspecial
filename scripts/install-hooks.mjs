#!/usr/bin/env node
// Wires the repo's .githooks/ dir into git via core.hooksPath.
// Runs from npm `prepare`. Silent no-op outside a git checkout (e.g. CI
// running `npm ci` against a tarball).

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".git")) process.exit(0);

try {
  execSync("git config core.hooksPath .githooks", { stdio: "ignore" });
} catch {
  // Non-fatal: dev can still build/test without hooks.
}
