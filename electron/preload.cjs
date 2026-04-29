const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gifMakerDesktop', {
  isDesktop: true,
  isAvailable: () => ipcRenderer.invoke('desktop:is-available'),
  openMedia: (mode) => ipcRenderer.invoke('desktop:open-media', mode),
  saveExport: (payload) => ipcRenderer.invoke('desktop:save-export', payload),
});
