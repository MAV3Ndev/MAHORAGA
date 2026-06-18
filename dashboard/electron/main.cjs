const { app, BrowserWindow, ipcMain, Menu, Notification, powerMonitor, shell } = require("electron");
const { createWriteStream } = require("node:fs");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const PANEL_WIDTH = 1660;
const PANEL_HEIGHT = 980;
const APP_USER_MODEL_ID = "jp.mahoraga.next.panel";
const RESUME_RELOAD_DELAY_MS = 1200;
const APP_TITLE = "MAHORAGA-Next SENTINEL";
const APP_ICON_PATH = path.join(__dirname, "..", "public", "icons", "app-icon.png");
const UPDATE_REPOSITORY = process.env.MAHORAGA_SENTINEL_UPDATE_REPO || "MAV3Ndev/MAHORAGA-Next";
const UPDATE_CHECK_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases`;
const LEGACY_USER_DATA_DIR_NAMES = ["MAHORAGA SENTINEL", "mahoraga-dashboard"];

let mainWindow = null;
let latestUpdate = null;
let updateDownloadInFlight = false;

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

function getConnectionFileCandidates() {
  const currentPath = getConnectionFilePath();
  const appDataPath = app.getPath("appData");
  return [
    currentPath,
    ...LEGACY_USER_DATA_DIR_NAMES.map((dirName) => path.join(appDataPath, dirName, "connection.json")),
  ].filter((candidate, index, candidates) => candidates.indexOf(candidate) === index);
}

async function readConnectionSettings() {
  const currentPath = getConnectionFilePath();

  for (const candidatePath of getConnectionFileCandidates()) {
    try {
      const raw = await readFile(candidatePath, "utf8");
      const parsed = JSON.parse(raw);
      const settings = {
        apiUrl: normalizeApiUrl(parsed.apiUrl),
        bearerToken: String(parsed.bearerToken || "").trim(),
      };

      if (candidatePath !== currentPath && settings.apiUrl && settings.bearerToken) {
        await saveConnectionSettings(settings);
      }

      return settings;
    } catch {
      // Try the next known settings location.
    }
  }

  return null;
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

function emitUpdateStatus(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("mahoraga:update", {
    timestamp: Date.now(),
    ...payload,
  });
}

function compareVersions(left, right) {
  const leftParts = String(left || "0").replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right || "0").replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }

  return 0;
}

function getAssetPlatformPattern() {
  if (process.platform === "win32") return /setup\.exe$/i;
  if (process.platform === "darwin") return /\.(dmg|zip)$/i;
  return /\.(appimage|deb|rpm)$/i;
}

function normalizeReleaseVersion(release) {
  const raw = String(release?.tag_name || release?.name || "").trim();
  return raw.replace(/^sentinel-v/i, "").replace(/^v/i, "");
}

function selectReleaseAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const platformPattern = getAssetPlatformPattern();
  return (
    assets.find((asset) => /MAHORAGA-Next SENTINEL/i.test(asset.name || "") && platformPattern.test(asset.name || "")) ||
    assets.find((asset) => platformPattern.test(asset.name || "")) ||
    null
  );
}

async function fetchLatestSentinelRelease() {
  const response = await fetch(UPDATE_CHECK_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `MAHORAGA-Next-SENTINEL/${app.getVersion()}`,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub release check failed: HTTP ${response.status}`);
  }

  const releases = await response.json();
  if (!Array.isArray(releases)) return null;

  return (
    releases.find((release) => {
      if (release?.draft || release?.prerelease) return false;
      if (!/^sentinel-v/i.test(String(release?.tag_name || ""))) return false;
      const asset = selectReleaseAsset(release);
      return Boolean(asset);
    }) || null
  );
}

async function checkForUpdates({ silent = false } = {}) {
  const currentVersion = app.getVersion();

  if (!silent) {
    emitUpdateStatus({ state: "checking", currentVersion });
  }

  try {
    const release = await fetchLatestSentinelRelease();
    if (!release) {
      latestUpdate = null;
      const result = { state: "not-available", currentVersion, message: "No Sentinel release artifact found." };
      emitUpdateStatus(result);
      return result;
    }

    const latestVersion = normalizeReleaseVersion(release);
    const asset = selectReleaseAsset(release);
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    latestUpdate = hasUpdate
      ? {
          version: latestVersion,
          releaseName: release.name || release.tag_name,
          releaseUrl: release.html_url,
          notes: release.body || "",
          assetName: asset.name,
          assetUrl: asset.browser_download_url,
        }
      : null;

    const result = hasUpdate
      ? { state: "available", currentVersion, update: latestUpdate }
      : { state: "not-available", currentVersion, latestVersion };
    emitUpdateStatus(result);
    return result;
  } catch (error) {
    const result = { state: "error", currentVersion, message: String(error instanceof Error ? error.message : error) };
    emitUpdateStatus(result);
    return result;
  }
}

async function downloadAndInstallUpdate() {
  if (updateDownloadInFlight) {
    return { state: "downloading", update: latestUpdate };
  }

  if (!latestUpdate) {
    const checked = await checkForUpdates({ silent: true });
    if (checked.state !== "available") return checked;
  }

  updateDownloadInFlight = true;
  const update = latestUpdate;
  const safeAssetName = path.basename(update.assetName || `MAHORAGA-Next-SENTINEL-${update.version}-setup.exe`);
  const targetPath = path.join(app.getPath("temp"), safeAssetName);

  try {
    emitUpdateStatus({ state: "downloading", update });
    const response = await fetch(update.assetUrl, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": `MAHORAGA-Next-SENTINEL/${app.getVersion()}`,
      },
    });

    if (!response.ok || !response.body) {
      throw new Error(`Update download failed: HTTP ${response.status}`);
    }

    const totalBytes = Number(response.headers.get("content-length") || 0);
    let downloadedBytes = 0;
    await mkdir(path.dirname(targetPath), { recursive: true });

    await new Promise((resolve, reject) => {
      const file = createWriteStream(targetPath);
      const reader = response.body.getReader();

      file.on("error", reject);
      file.on("finish", resolve);

      const pump = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              file.end();
              return;
            }

            const chunk = Buffer.from(value);
            downloadedBytes += chunk.length;
            if (totalBytes > 0) {
              emitUpdateStatus({
                state: "downloading",
                update,
                progress: Math.round((downloadedBytes / totalBytes) * 100),
              });
            }

            if (!file.write(chunk)) {
              file.once("drain", pump);
              return;
            }
            pump();
          })
          .catch(reject);
      };

      pump();
    });

    emitUpdateStatus({ state: "downloaded", update, filePath: targetPath });
    const openError = await shell.openPath(targetPath);
    if (openError) throw new Error(openError);

    setTimeout(() => app.quit(), 700);
    return { state: "installing", update };
  } catch (error) {
    const result = { state: "error", update, message: String(error instanceof Error ? error.message : error) };
    emitUpdateStatus(result);
    return result;
  } finally {
    updateDownloadInFlight = false;
  }
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
    title: APP_TITLE,
    icon: APP_ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true,
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
    window.setMenuBarVisibility(false);
    window.show();
  });

  window.on("show", () => {
    if (!window.isDestroyed()) {
      window.webContents.send("mahoraga:lifecycle", { type: "window-show" });
    }
  });

  window.on("hide", () => {
    if (!window.isDestroyed()) {
      window.webContents.send("mahoraga:lifecycle", { type: "window-hide" });
    }
  });

  window.on("focus", () => {
    if (!window.isDestroyed()) {
      window.webContents.send("mahoraga:lifecycle", { type: "window-focus" });
    }
  });

  window.on("blur", () => {
    if (!window.isDestroyed()) {
      window.webContents.send("mahoraga:lifecycle", { type: "window-blur" });
    }
  });

  window.on("minimize", () => {
    if (!window.isDestroyed()) {
      window.webContents.send("mahoraga:lifecycle", { type: "window-minimize" });
    }
  });

  window.on("restore", () => {
    if (!window.isDestroyed()) {
      window.webContents.send("mahoraga:lifecycle", { type: "window-restore" });
    }
  });

  window.webContents.on("did-finish-load", () => {
    if (!window.isDestroyed()) {
      window.webContents.send("mahoraga:lifecycle", { type: "renderer-ready" });
    }
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("[MAHORAGA-Next] Renderer process gone", details);
    if (!window.isDestroyed()) {
      window.webContents.reloadIgnoringCache();
    }
  });

  window.on("unresponsive", () => {
    console.warn("[MAHORAGA-Next] Window became unresponsive, reloading renderer");
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
  Menu.setApplicationMenu(null);

  ipcMain.handle("mahoraga:connection:load", async () => readConnectionSettings());
  ipcMain.handle("mahoraga:connection:save", async (_event, settings) => saveConnectionSettings(settings));
  ipcMain.handle("mahoraga:request", async (_event, input) => requestAgent(input));
  ipcMain.handle("mahoraga:app-version", async () => app.getVersion());
  ipcMain.handle("mahoraga:update:check", async (_event, input) => checkForUpdates(input));
  ipcMain.handle("mahoraga:update:install", async () => downloadAndInstallUpdate());
  ipcMain.handle("mahoraga:open-external", async (_event, url) => {
    await shell.openExternal(url);
  });
  ipcMain.handle("mahoraga:notify", async (_event, payload) => {
    if (!Notification.isSupported()) {
      return false;
    }

    const notification = new Notification({
      title: String(payload?.title || APP_TITLE),
      body: String(payload?.body || ""),
      silent: false,
    });

    notification.show();
    return true;
  });

  mainWindow = createMainWindow();

  if (app.isPackaged) {
    setTimeout(() => {
      void checkForUpdates({ silent: true });
    }, 10_000);
  }

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
