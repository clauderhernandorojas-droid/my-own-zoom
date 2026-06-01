const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__MOJ_ELECTRON', true);

contextBridge.exposeInMainWorld('mojElectron', {
  getDesktopSources: (opts) => ipcRenderer.invoke('moj:get-desktop-sources', opts || {}),
  notifyScreenSourceSelected: (sourceId) =>
    ipcRenderer.invoke('moj:notify-screen-source-selected', {
      sourceId: String(sourceId || ''),
    }),
});
