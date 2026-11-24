const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('svitlo', {
  getModel: () => ipcRenderer.invoke('model'),
  refresh: () => ipcRenderer.invoke('refresh'),
  setActive: (i) => ipcRenderer.send('set-active', i),
  addQueue: (name, id) => ipcRenderer.send('add-queue', { name, id }),
  removeQueue: (i) => ipcRenderer.send('remove-queue', i),
  openVoe: () => ipcRenderer.send('open-voe'),
  quit: () => ipcRenderer.send('quit'),
  hide: () => ipcRenderer.send('hide'),
  reportHeight: (h) => ipcRenderer.send('height', h),
  onModel: (fn) => ipcRenderer.on('model', (_e, m) => fn(m)),
  onOpen: (fn) => ipcRenderer.on('open', () => fn()),
  onClose: (fn) => ipcRenderer.on('close', () => fn()),
});
