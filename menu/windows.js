/**
 * Small helper for opening plugin windows (status/diff, diagram diff,
 * issues) that talk back to the main process over a namespaced IPC
 * channel, via a shared preload script.
 *
 * Each window gets its own auto-generated namespace. The preload script
 * reads it from the page's URL query string and exposes
 * `window.gitPlugin.invoke(key, ...args)`, which calls
 * `ipcMain.handle('git-plugin:<ns>:<key>', ...)` on the main side.
 *
 * Handlers are registered when the window opens and removed when it
 * closes, so the same window type can be opened more than once (even
 * concurrently) without "second handler" registration errors.
 */

'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, shell } = require('electron');

let counter = 0;

function openWindow({ kind, title, htmlFile, width, height, handlers }) {
  const ns = `${kind}-${Date.now()}-${counter++}`;

  const win = new BrowserWindow({
    title,
    width: width || 900,
    height: height || 640,
    webPreferences: {
      preload: path.join(__dirname, '..', 'ui', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const registeredChannels = [];

  function register(key, handler) {
    const channel = `git-plugin:${ns}:${key}`;
    ipcMain.handle(channel, (_event, ...args) => handler(...args));
    registeredChannels.push(channel);
  }

  // Every window gets an "openExternal" handler for free.
  register('openExternal', url => shell.openExternal(url));

  Object.keys(handlers || {}).forEach(key => register(key, handlers[key]));

  win.on('closed', () => {
    registeredChannels.forEach(channel => ipcMain.removeHandler(channel));
  });

  win.loadFile(path.join(__dirname, '..', 'ui', htmlFile), {
    query: { ns }
  });

  return win;
}

module.exports = { openWindow };
