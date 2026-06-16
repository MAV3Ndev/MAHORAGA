const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mahoragaDesktop", {
  loadConnectionSettings: () => ipcRenderer.invoke("mahoraga:connection:load"),
  saveConnectionSettings: (settings) => ipcRenderer.invoke("mahoraga:connection:save", settings),
  request: (input) => ipcRenderer.invoke("mahoraga:request", input),
  getAppVersion: () => ipcRenderer.invoke("mahoraga:app-version"),
  checkForUpdates: (input) => ipcRenderer.invoke("mahoraga:update:check", input),
  installUpdate: () => ipcRenderer.invoke("mahoraga:update:install"),
  openExternal: (url) => ipcRenderer.invoke("mahoraga:open-external", url),
  notify: (payload) => ipcRenderer.invoke("mahoraga:notify", payload),
  onUpdateEvent: (listener) => {
    const wrappedListener = (_event, payload) => listener(payload);
    ipcRenderer.on("mahoraga:update", wrappedListener);
    return () => {
      ipcRenderer.removeListener("mahoraga:update", wrappedListener);
    };
  },
  onLifecycleEvent: (listener) => {
    const wrappedListener = (_event, payload) => listener(payload);
    ipcRenderer.on("mahoraga:lifecycle", wrappedListener);
    return () => {
      ipcRenderer.removeListener("mahoraga:lifecycle", wrappedListener);
    };
  },
});
