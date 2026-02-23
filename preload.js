'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// Весь API MindPod через безопасный IPC мост
contextBridge.exposeInMainWorld('mp', {
  // Система
  version:      ()      => ipcRenderer.invoke('mp-version'),
  home:         ()      => ipcRenderer.invoke('mp-home'),
  sysinfo:      ()      => ipcRenderer.invoke('mp-sysinfo'),
  catalog:      ()      => ipcRenderer.invoke('mp-catalog'),
  getSettings:  ()      => ipcRenderer.invoke('mp-get-settings'),
  setSetting:   (k, v)  => ipcRenderer.invoke('mp-set-setting', k, v),
  setTheme:     t       => ipcRenderer.invoke('mp-set-theme', t),

  // Приложения
  installed:     ()      => ipcRenderer.invoke('mp-installed'),
  isInstalled:   id      => ipcRenderer.invoke('mp-is-installed', id),
  installedMeta: id      => ipcRenderer.invoke('mp-installed-meta', id),
  running:       ()      => ipcRenderer.invoke('mp-running'),
  install:       id      => ipcRenderer.invoke('mp-install', id),
  update:        id      => ipcRenderer.invoke('mp-update', id),
  launch:        id      => ipcRenderer.invoke('mp-launch', id),
  stop:          id      => ipcRenderer.invoke('mp-stop', id),
  stopAll:       ()      => ipcRenderer.invoke('mp-stop-all'),
  uninstall:     id      => ipcRenderer.invoke('mp-uninstall', id),
  checkUpdate:   id      => ipcRenderer.invoke('mp-check-update', id),
  openApp:       id      => ipcRenderer.invoke('mp-open-app', id),

  // Файловая система
  openPath:    p    => ipcRenderer.invoke('mp-open-path', p),
  openUrl:     url  => ipcRenderer.invoke('mp-open-url', url),
  showFolder:  id   => ipcRenderer.invoke('mp-show-folder', id),

  // Окно
  minimize:    () => ipcRenderer.send('mp-minimize'),
  maximize:    () => ipcRenderer.send('mp-maximize'),
  close:       () => ipcRenderer.send('mp-close'),
  isMaximized: () => ipcRenderer.sendSync('mp-is-maximized'),

  // События (от main → renderer)
  on: (event, fn) => {
    const allowed = ['log', 'progress', 'installed', 'stopped']
    if (allowed.includes(event)) {
      ipcRenderer.on('mp-' + event, (_, data) => fn(data))
    }
  },
  off: event => ipcRenderer.removeAllListeners('mp-' + event),
})
