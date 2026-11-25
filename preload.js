const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (state) => ipcRenderer.invoke('data:save', state),
  exportData: (state) => ipcRenderer.invoke('data:export', state),
  importData: () => ipcRenderer.invoke('data:import'),
  exportCSV: (name, csv) => ipcRenderer.invoke('data:exportCSV', name, csv),
  exportPDF: (html, name) => ipcRenderer.invoke('report:pdf', html, name),
  openDataFolder: () => ipcRenderer.invoke('data:openFolder'),
  askAI: (payload) => ipcRenderer.invoke('ai:ask', payload),
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update:status', (_e, data) => cb(data))
});
