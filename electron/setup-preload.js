const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  defaults: () => ipcRenderer.invoke('setup:defaults'),
  pickFolder: () => ipcRenderer.invoke('setup:pickFolder'),
  save: (data) => ipcRenderer.invoke('setup:save', data)
});
