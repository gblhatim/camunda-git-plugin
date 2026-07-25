'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const params = new URLSearchParams(window.location.search);
const ns = params.get('ns');

contextBridge.exposeInMainWorld('gitPlugin', {
  invoke: (key, ...args) => ipcRenderer.invoke(`git-plugin:${ns}:${key}`, ...args)
});
