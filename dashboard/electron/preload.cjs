const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mahoragaDesktop", {
  loadConnectionSettings: () => ipcRenderer.invoke("mahoraga:connection:load"),
  saveConnectionSettings: (settings) => ipcRenderer.invoke("mahoraga:connection:save", settings),
  request: (input) => ipcRenderer.invoke("mahoraga:request", input),
  openExternal: (url) => ipcRenderer.invoke("mahoraga:open-external", url),
  notify: (payload) => ipcRenderer.invoke("mahoraga:notify", payload),
  onLifecycleEvent: (listener) => {
    const wrappedListener = (_event, payload) => listener(payload);
    ipcRenderer.on("mahoraga:lifecycle", wrappedListener);
    return () => {
      ipcRenderer.removeListener("mahoraga:lifecycle", wrappedListener);
    };
  },
});
