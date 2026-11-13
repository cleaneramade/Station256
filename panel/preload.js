const { contextBridge, ipcRenderer, webFrame } = require('electron');

const CHANNELS = ['aitools:status', 'window:close-request', 'window:link', 'window:arrange', 'obscura:dark', 'engine:changed', 'link:open', 'clipboard:no-helper', 'zoom:changed', 'term:data', 'term:exit', 'term:show', 'tab:arrive', 'tab:landed', 'tabs:gap', 'tab:half', 'windows:changed', 'copy:progress', 'agents:update', 'agents:tabs', 'agents:open', 'voice:text', 'voice:edit', 'live:style', 'live:reload', 'video:progress', 'llama:status', 'llama:chat', 'github:progress', 'schedules:update', 'obscura:event', 'search:batch', 'search:done', 'preview:open', 'aibrowser:tab', 'aibrowser:close', 'aibrowser:ask', 'aibrowser:pointer'];

contextBridge.exposeInMainWorld('house', {
  call: (name, ...args) => ipcRenderer.invoke('call', name, args),
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
  getZoomFactor: () => webFrame.getZoomFactor(),
  on: (channel, callback) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_event, value) => callback(value));
  },
});
