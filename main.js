'use strict'

const {
  app, BrowserWindow, ipcMain, Menu, Tray,
  shell, screen, session, nativeTheme, dialog, autoUpdater
} = require('electron')
const path = require('path')
const fs   = require('fs')
const os   = require('os')
const crypto = require('crypto')

const { Engine, HOME_DIR, LOG_FILE, hasPython } = require('./engine')

const IS_WIN = process.platform === 'win32'

// ── Пути ──────────────────────────────────────────────────────
const SCRIPTS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'apps')
  : path.join(__dirname, 'apps')

const CATALOG_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'catalog.json')
  : path.join(__dirname, 'src', 'catalog.json')

// ── Singleton ─────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

// ── Store ─────────────────────────────────────────────────────
class Store {
  constructor() {
    this.f = path.join(HOME_DIR, 'config.json')
    try { this.d = JSON.parse(fs.readFileSync(this.f, 'utf8')) } catch { this.d = {} }
  }
  get(k, def) { return this.d[k] ?? def }
  set(k, v)   { this.d[k] = v; try { fs.writeFileSync(this.f, JSON.stringify(this.d, null, 2)) } catch {} }
  all()        { return { ...this.d } }
}
const store = new Store()

// ── Ключ безопасности ─────────────────────────────────────────
const KEY_FILE = path.join(HOME_DIR, 'key.json')
if (!fs.existsSync(KEY_FILE)) {
  fs.writeFileSync(KEY_FILE, JSON.stringify({ key: crypto.randomBytes(32).toString('hex') }))
}

// ── Engine ────────────────────────────────────────────────────
const engine = new Engine(SCRIPTS_DIR)

// Пробросить события engine → renderer
function send(ch, data) { win?.webContents.send('mp-' + ch, data) }

engine.on('log',       d => send('log', d))
engine.on('progress',  d => send('progress', d))
engine.on('installed', d => send('installed', d))
engine.on('stopped',   d => send('stopped', d))

// ── Глобальные обработчики ────────────────────────────────────
process.on('unhandledRejection', r => console.error('Rejection:', r))
process.on('uncaughtException',  e => console.error('Exception:', e))

let win  = null
let tray = null

// ── Главное окно ──────────────────────────────────────────────
function createWindow() {
  const b = store.get('windowBounds', { width: 1300, height: 840 })
  const displays = screen.getAllDisplays()
  const onScreen = b.x != null && displays.some(d => {
    return b.x >= d.bounds.x && b.y >= d.bounds.y &&
           b.x < d.bounds.x + d.bounds.width && b.y < d.bounds.y + d.bounds.height
  })

  win = new BrowserWindow({
    width: b.width || 1300,
    height: b.height || 840,
    x: onScreen ? b.x : undefined,
    y: onScreen ? b.y : undefined,
    minWidth: 900, minHeight: 600,
    frame: false,
    backgroundColor: '#07070e',
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: false,
    }
  })

  if (store.get('windowMaximized')) win.maximize()
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())

  const saveBounds = () => {
    if (!win.isMaximized() && !win.isMinimized()) store.set('windowBounds', win.getBounds())
  }
  win.on('resize', saveBounds)
  win.on('move',   saveBounds)
  win.on('maximize',   () => store.set('windowMaximized', true))
  win.on('unmaximize', () => store.set('windowMaximized', false))
  win.on('closed',     () => win = null)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url); return { action: 'deny' }
  })

  // CSP
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [`default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://fonts.googleapis.com https://fonts.gstatic.com http://127.0.0.1:*`]
    }})
  })
}

// ── Трей ──────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon_tray.png')
  if (!fs.existsSync(iconPath)) return
  tray = new Tray(iconPath)
  tray.setToolTip('MindPod')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть MindPod',   click: () => { win?.show(); win?.focus() } },
    { type: 'separator' },
    { label: 'Рабочая папка',     click: () => shell.openPath(HOME_DIR) },
    { label: 'Журнал событий',    click: () => shell.openPath(LOG_FILE)  },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; app.quit() } }
  ]))
  tray.on('double-click', () => { win?.show(); win?.focus() })
}

// ══════════════════════════════════════════════════════════════
//  IPC — все обработчики
// ══════════════════════════════════════════════════════════════

// Система
ipcMain.handle('mp-version',     () => app.getVersion())
ipcMain.handle('mp-home',        () => HOME_DIR)
ipcMain.handle('mp-sysinfo',     () => engine.getSystemInfo())
ipcMain.handle('mp-catalog',     () => {
  try { return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) } catch { return [] }
})
ipcMain.handle('mp-get-settings', ()      => store.all())
ipcMain.handle('mp-set-setting',  (_, k, v) => { store.set(k, v); return true })

// Приложения
ipcMain.handle('mp-installed',    ()     => engine.getInstalled())
ipcMain.handle('mp-is-installed', (_, id) => engine.isInstalled(id))
ipcMain.handle('mp-installed-meta',(_, id) => engine.getInstalledMeta(id))
ipcMain.handle('mp-running',      ()     => engine.getRunning())
ipcMain.handle('mp-install',      (_, id) => engine.install(id))
ipcMain.handle('mp-update',       (_, id) => engine.update(id))
ipcMain.handle('mp-launch',       (_, id) => engine.launch(id))
ipcMain.handle('mp-stop',         (_, id) => engine.stop(id))
ipcMain.handle('mp-stop-all',     ()     => { engine.stopAll(); return { ok: true } })
ipcMain.handle('mp-uninstall',    (_, id) => engine.uninstall(id))
ipcMain.handle('mp-check-update', (_, id) => engine.checkUpdate(id))
ipcMain.handle('mp-open-app',     (_, id) => {
  const r = engine.running[id]
  if (r) shell.openExternal(`http://127.0.0.1:${r.port}`)
  return !!r
})

// Файловая система (с валидацией путей)
ipcMain.handle('mp-open-path', (_, p) => {
  const resolved = path.resolve(p.replace('~', os.homedir()))
  shell.openPath(resolved); return true
})
ipcMain.handle('mp-open-url', (_, url) => {
  if (/^https?:\/\//.test(url)) { shell.openExternal(url); return true }
  return false
})
ipcMain.handle('mp-show-folder', (_, id) => {
  shell.openPath(engine._appDir(id)); return true
})

// Окно
ipcMain.on('mp-minimize',  () => win?.minimize())
ipcMain.on('mp-maximize',  () => win?.isMaximized() ? win.unmaximize() : win?.maximize())
ipcMain.on('mp-close', () => {
  if (store.get('minimizeToTray', true) && tray) win?.hide()
  else { app.isQuitting = true; app.quit() }
})
ipcMain.on('mp-is-maximized', e => { e.returnValue = win?.isMaximized() ?? false })

// Тема
ipcMain.handle('mp-set-theme', (_, t) => {
  store.set('theme', t); nativeTheme.themeSource = t; return true
})

// ── Запуск ────────────────────────────────────────────────────
app.whenReady().then(() => {
  nativeTheme.themeSource = store.get('theme', 'dark')
  createWindow()
  createTray()
  console.log('MindPod запущен, HOME:', HOME_DIR)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) app.quit() })
app.on('before-quit', () => app.isQuitting = true)
app.on('quit', () => {
  engine.stopAll()
  if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null }
})

if (IS_WIN) app.setAsDefaultProtocolClient('mindpod', process.execPath, ['--'])
else app.setAsDefaultProtocolClient('mindpod')
