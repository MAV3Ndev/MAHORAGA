import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rendererUrl = "http://127.0.0.1:3000";
const children = [];
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..");
const viteEntry = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const electronBinary = path.join(
  projectRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

function run(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    cwd: projectRoot,
  });

  child.on("exit", (code) => {
    if (label === "electron") {
      shutdown(code ?? 0);
      return;
    }

    if (code && code !== 0) {
      shutdown(code);
    }
  });

  children.push(child);
  return child;
}

async function waitForRenderer(url, timeoutMs = 60000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Renderer still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  throw new Error(`Renderer did not become ready within ${timeoutMs}ms`);
}

function shutdown(code = 0) {
  while (children.length > 0) {
    const child = children.pop();
    if (child && !child.killed) {
      child.kill();
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("vite", process.execPath, [viteEntry, "--host", "127.0.0.1", "--port", "3000"]);

try {
  await waitForRenderer(rendererUrl);
} catch (error) {
  shutdown(1);
  throw error;
}

run("electron", electronBinary, ["electron/main.cjs"], {
  MAHORAGA_PANEL_RENDERER_URL: rendererUrl,
});
