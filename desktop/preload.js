'use strict';

// What the player window may ask the app for (window.desktop). player/desktop.js uses it.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  ready: () => ipcRenderer.invoke('ready'), // returns files given on the command line
  pick: kind => ipcRenderer.invoke('pick', kind), // 'file' or 'folder'
  readBook: target => ipcRenderer.invoke('read-book', target),
  scanLibrary: () => ipcRenderer.invoke('scan-library'),
  libraryFolders: () => ipcRenderer.invoke('library-folders'),
  setLibraryFolders: folders => ipcRenderer.invoke('set-library-folders', folders),
  showInFolder: target => ipcRenderer.invoke('show-in-folder', target),
  pathOf: file => webUtils.getPathForFile(file), // the real path of a dropped file
  setPlaying: playing => ipcRenderer.send('playing', playing),
  setMini: on => ipcRenderer.send('mini', on),
  onOpenPaths: handler => ipcRenderer.on('open-paths', (_e, paths) => handler(paths)),
  onCommand: handler => ipcRenderer.on('command', (_e, command) => handler(command)),
});
