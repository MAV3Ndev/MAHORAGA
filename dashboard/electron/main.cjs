const { app, BrowserWindow, ipcMain, Notification, powerMonitor, shell } = require("electron");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const PANEL_WIDTH = 1660;
const PANEL_HEIGHT = 980;
const APP_USER_MODEL_ID = "jp.mahoraga.panel";
const RESUME_RELOAD_DELAY_MS = 1200;

let mainWindow = null;

// Keep Chromium's GPU pipeline enabled for smooth dashboard rendering.
// Black-screen recovery is handled by the lifecycle reload hooks below.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

function normalizeApiUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  const needsProtocol = !/^[a-zA-Z]+:\/\//.test(trimmed);
  const protocol = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(trimmed) ? "http://" : "https://";
  const normalized = new URL(needsProtocol ? `${protocol}${trimmed}` : trimmed);
  normalized.hash = "";
  normalized.pathname = normalized.pathname.replace(/\/+$/, "").replace(/\/agent$/, "");
  return normalized.toString().replace(/\/$/, "");
}

function getConnectionFilePath() {
  return path.join(app.getPath("userData"), "connection.json");
}

async function readConnectionSettings() {
  try {
    const raw = await readFile(getConnectionFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      apiUrl: normalizeApiUrl(parsed.apiUrl),
      bearerToken: String(parsed.bearerToken || "").trim(),
    };
  } catch {
    return null;
  }
}

async function saveConnectionSettings(settings) {
  const payload = {
    apiUrl: normalizeApiUrl(settings?.apiUrl),
    bearerToken: String(settings?.bearerToken || "").trim(),
  };

  await mkdir(path.dirname(getConnectionFilePath()), { recursive: true });
  await writeFile(getConnectionFilePath(), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function buildAgentUrl(baseUrl, agentPath) {
  const root = new URL(normalizeApiUrl(baseUrl));
  const requested = new URL(agentPath.startsWith("/") ? agentPath : `/${agentPath}`, "http://mahoraga.local");
  const basePath = root.pathname.replace(/\/$/, "");
  root.pathname = `${basePath}/agent${requested.pathname}`.replace(/\/{2,}/g, "/");
  root.search = requested.search;
  return root.toString();
}

async function requestAgent(input) {
  const connection = input?.connection || (await readConnectionSettings());
  const apiUrl = normalizeApiUrl(connection?.apiUrl);
  const bearerToken = String(connection?.bearerToken || "").trim();

  if (!apiUrl || !bearerToken) {
    throw new Error("Connection is not configured. Set API URL and Bearer token first.");
  }

  const url = buildAgentUrl(apiUrl, input?.path || "/status");
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${bearerToken}`,
  };

  let body;
  if (input?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(input.body);
  }

  const response = await fetch(url, {
    method: input?.method || "GET",
    headers,
    body,
  });

  const text = await response.text();
  let data = text;

  try {
    data = JSON.parse(text);
  } catch {
    // Keep plain text bodies intact.
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    minWidth: 1240,
    minHeight: 820,
    backgroundColor: "#04070a",
    title: "MAHORAGA PANEL",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const devServerUrl = process.env.MAHORAGA_PANEL_RENDERER_URL;
  if (devServerUrl) {
    window.loadURL(devServerUrl);
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("show", () => {
    if (!window.isDestroyed()) {
      window.webContents.send("mahoraga:lifecycle", { type: "window-show" });
    }
  });

  window.on("focus", () => {
    if (!window.isDestroyed()) {
      window.webContents.send("mahoraga:lifecycle", { type: "window-focus" });
    }
  });

  window.webContents.on("did-finish-load", () => {
    if (!window.isDestroyed()) {
      window.webContents.send("mahoraga:lifecycle", { type: "renderer-ready" });
    }
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("[MAHORAGA] Renderer process gone", details);
    if (!window.isDestroyed()) {
      window.webContents.reloadIgnoringCache();
    }
  });

  window.on("unresponsive", () => {
    console.warn("[MAHORAGA] Window became unresponsive, reloading renderer");
    if (!window.isDestroyed()) {
      window.webContents.reloadIgnoringCache();
    }
  });

  return window;
}

function recoverWindow(type) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("mahoraga:lifecycle", {
    type,
    timestamp: Date.now(),
  });

  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.reloadIgnoringCache();
  }, RESUME_RELOAD_DELAY_MS);
}

app.whenReady().then(() => {
  app.setAppUserModelId(APP_USER_MODEL_ID);

  ipcMain.handle("mahoraga:connection:load", async () => readConnectionSettings());
  ipcMain.handle("mahoraga:connection:save", async (_event, settings) => saveConnectionSettings(settings));
  ipcMain.handle("mahoraga:request", async (_event, input) => requestAgent(input));
  ipcMain.handle("mahoraga:open-external", async (_event, url) => {
    await shell.openExternal(url);
  });
  ipcMain.handle("mahoraga:notify", async (_event, payload) => {
    if (!Notification.isSupported()) {
      return false;
    }

    const notification = new Notification({
      title: String(payload?.title || "MAHORAGA"),
      body: String(payload?.body || ""),
      silent: false,
    });

    notification.show();
    return true;
  });

  mainWindow = createMainWindow();

  powerMonitor.on("resume", () => recoverWindow("system-resume"));
  powerMonitor.on("unlock-screen", () => recoverWindow("screen-unlock"));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      return;
    }

    const existingWindow = BrowserWindow.getAllWindows()[0];
    if (existingWindow) {
      existingWindow.show();
      existingWindow.focus();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
