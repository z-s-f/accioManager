// Preload script for Electron
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onOAuthSuccess: (callback) => ipcRenderer.on('oauth-success', (event, data) => callback(data)),
  selectDirectory: () => ipcRenderer.invoke('select-directory')
});

window.addEventListener('DOMContentLoaded', () => {
  console.log('--- desktop mode activated ---');
  document.body.classList.add('desktop-mode');
});
