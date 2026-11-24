'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guard', {
  state: () => ipcRenderer.invoke('state'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  openSite: (id) => ipcRenderer.invoke('open-site', id),
  updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),
  openFolder: (which) => ipcRenderer.invoke('open-folder', which),
  on: (channel, fn) => {
    if (!['status', 'activity', 'settings', 'log'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
