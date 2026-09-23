'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('timeline', {
  load: (file) => ipcRenderer.invoke('timeline:load', file),
  pick: () => ipcRenderer.invoke('timeline:pick'),
  regions: () => ipcRenderer.invoke('regions:load'),
  // File.path was removed from the renderer in Electron 32; this is the replacement.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
});
