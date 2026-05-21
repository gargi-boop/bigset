import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Run a backend benchmark entry script via tsx (avoids npm run stdout banners).
 * Executes with cwd=backend so dotenv loads backend/.env.
 */
export function spawnBackendBenchmark(scriptPath) {
  const absoluteScript = join(repoRoot, "backend", scriptPath);
  return runCommand("npx", ["tsx", absoluteScript], {
    cwd: join(repoRoot, "backend"),
    env: process.env,
  });
}

function runCommand(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
      cwd: options.cwd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
  });
}
