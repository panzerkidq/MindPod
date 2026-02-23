'use strict'

/**
 * MindPod Engine v1.0
 * ─────────────────────────────────────────────────────────────
 * Ядро управления AI-приложениями:
 *  • Встроенный портативный Python (скачивается при первом запуске)
 *  • Изолированный venv для каждого приложения
 *  • git clone / git pull (установка и обновление)
 *  • pip install в изолированную среду
 *  • Запуск / остановка процессов
 *  • Авто-обновление приложений
 */

const path   = require('path')
const fs     = require('fs')
const os     = require('os')
const net    = require('net')
const https  = require('https')
const http   = require('http')
const { spawn, exec, execSync } = require('child_process')
const { EventEmitter } = require('events')

const IS_WIN   = process.platform === 'win32'
const IS_MAC   = process.platform === 'darwin'
const IS_LINUX = process.platform === 'linux'

// ── Пути ──────────────────────────────────────────────────────
const HOME_DIR    = path.join(os.homedir(), 'mindpod')
const RUNTIME_DIR = path.join(HOME_DIR, 'runtime')        // встроенный Python
const APPS_DIR_   = path.join(HOME_DIR, 'apps')            // данные приложений
const LOG_DIR     = path.join(HOME_DIR, 'logs')
const VENV_DIR    = path.join(HOME_DIR, 'venvs')           // виртуальные среды

for (const d of [HOME_DIR, RUNTIME_DIR, APPS_DIR_, LOG_DIR, VENV_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

// ── Логирование ───────────────────────────────────────────────
const LOG_FILE = path.join(LOG_DIR, 'engine.log')
const log = (m, l = 'INFO') => {
  const s = `[${new Date().toISOString()}] [${l}] ${m}`
  console.log(s)
  try { fs.appendFileSync(LOG_FILE, s + '\n') } catch {}
}

// ── Портативный Python ────────────────────────────────────────
// Скачиваем Python Embeddable (Windows) или используем системный (Mac/Linux)
const PYTHON_DIR = path.join(RUNTIME_DIR, 'python')
const PYTHON_EXE = IS_WIN
  ? path.join(PYTHON_DIR, 'python.exe')
  : IS_MAC
    ? path.join(PYTHON_DIR, 'bin', 'python3')
    : path.join(PYTHON_DIR, 'bin', 'python3')

const PIP_BOOTSTRAP = path.join(RUNTIME_DIR, 'get-pip.py')

// Python 3.11 embeddable URLs
const PYTHON_URLS = {
  win32:  'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',
  darwin: null, // на Mac используем Homebrew/system python
  linux:  null, // на Linux используем system python
}

function hasPython() {
  if (IS_WIN) return fs.existsSync(PYTHON_EXE)
  // На Mac/Linux проверяем системный python3
  try { execSync('python3 --version', { stdio: 'ignore' }); return true } catch { return false }
}

function getPythonExe() {
  if (IS_WIN && fs.existsSync(PYTHON_EXE)) return PYTHON_EXE
  if (!IS_WIN) {
    for (const cmd of ['python3.11', 'python3.10', 'python3', 'python']) {
      try { execSync(`${cmd} --version`, { stdio: 'ignore' }); return cmd } catch {}
    }
  }
  return 'python3'
}

function getGitExe() {
  try { execSync('git --version', { stdio: 'ignore' }); return 'git' } catch {}
  if (IS_WIN) {
    const paths = [
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe',
    ]
    for (const p of paths) { if (fs.existsSync(p)) return p }
  }
  return 'git'
}

// ── Виртуальные среды ─────────────────────────────────────────
function getVenvDir(appId) { return path.join(VENV_DIR, appId) }

function getVenvPython(appId) {
  const v = getVenvDir(appId)
  if (IS_WIN) return path.join(v, 'Scripts', 'python.exe')
  return path.join(v, 'bin', 'python')
}

function getVenvPip(appId) {
  const v = getVenvDir(appId)
  if (IS_WIN) return path.join(v, 'Scripts', 'pip.exe')
  return path.join(v, 'bin', 'pip')
}

function hasVenv(appId) {
  return fs.existsSync(getVenvPython(appId))
}

// ── Свободный порт ────────────────────────────────────────────
function freePort(from = 43010) {
  return new Promise((res, rej) => {
    const t = p => {
      if (p > 43300) return rej(new Error('Нет свободных портов'))
      const s = net.createServer()
      s.once('error', () => t(p + 1))
      s.once('listening', () => s.close(() => res(p)))
      s.listen(p, '127.0.0.1')
    }
    t(from)
  })
}

// ── Скачать файл ──────────────────────────────────────────────
function download(url, dest, onProgress) {
  return new Promise((res, rej) => {
    const proto = url.startsWith('https') ? https : http
    const file  = fs.createWriteStream(dest)
    proto.get(url, r => {
      if (r.statusCode === 301 || r.statusCode === 302) {
        file.close(); fs.unlinkSync(dest)
        return download(r.headers.location, dest, onProgress).then(res).catch(rej)
      }
      const total = parseInt(r.headers['content-length'] || '0')
      let received = 0
      r.on('data', chunk => {
        received += chunk.length
        if (total && onProgress) onProgress(Math.round(received / total * 100))
      })
      r.pipe(file)
      file.on('finish', () => file.close(res))
      file.on('error', rej)
    }).on('error', rej)
  })
}

// ── Унzip ─────────────────────────────────────────────────────
function unzip(zipPath, dest) {
  return new Promise((res, rej) => {
    if (IS_WIN) {
      const cmd = `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${dest}' -Force"`
      exec(cmd, err => err ? rej(err) : res())
    } else {
      exec(`unzip -o "${zipPath}" -d "${dest}"`, err => err ? rej(err) : res())
    }
  })
}

// ── Spawn с логом ─────────────────────────────────────────────
function spawnLogged(cmd, args, opts, onData) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { shell: true, ...opts })
    p.stdout?.on('data', d => { const s = d.toString().trim(); if (s) onData?.(s, 'o') })
    p.stderr?.on('data', d => { const s = d.toString().trim(); if (s) onData?.(s, 'w') })
    p.on('exit', code => res(code || 0))
    p.on('error', e => { onData?.(e.message, 'er'); res(1) })
  })
}

// ═══════════════════════════════════════════════════════════════
//  ENGINE CLASS
// ═══════════════════════════════════════════════════════════════
class Engine extends EventEmitter {
  constructor(scriptsDir) {
    super()
    this.scriptsDir = scriptsDir  // папка apps/ из ресурсов
    this.running    = {}          // { id: {proc, port, pid} }
    this.installing = new Set()
    log('Engine инициализирован')
  }

  emit_(ch, data) { this.emit(ch, data) }

  _log(msg, type = 'o', appId = null) {
    log(`[${appId || 'engine'}] ${msg}`, type === 'er' ? 'ERROR' : 'INFO')
    this.emit_('log', { msg, type, appId })
  }

  _progress(appId, step, total, pct, label = '') {
    this.emit_('progress', { id: appId, step, total, pct, label })
  }

  // ── Скрипты ────────────────────────────────────────────────
  _script(appId, name) {
    const p = path.join(this.scriptsDir, appId, name)
    if (!fs.existsSync(p)) return null
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
  }

  // ── Пути приложения ────────────────────────────────────────
  _appDir(appId) { return path.join(APPS_DIR_, appId) }
  _marker(appId) { return path.join(this._appDir(appId), '.mp_installed') }

  isInstalled(appId) { return fs.existsSync(this._marker(appId)) }

  getInstalled() {
    const r = []
    try {
      for (const d of fs.readdirSync(APPS_DIR_)) {
        if (this.isInstalled(d)) r.push(d)
      }
    } catch {}
    return r
  }

  getInstalledMeta(appId) {
    try { return JSON.parse(fs.readFileSync(this._marker(appId), 'utf8')) } catch { return {} }
  }

  // ── Установка встроенного Python (Windows) ─────────────────
  async ensurePython(onData) {
    if (hasPython()) { onData?.('Python найден', 'ok'); return true }
    if (!IS_WIN) {
      onData?.('ОШИБКА: Python не найден. Установите python3 через пакетный менеджер.', 'er')
      return false
    }

    onData?.('Скачиваю портативный Python 3.11…', 'in')
    const zipPath = path.join(RUNTIME_DIR, 'python.zip')

    try {
      await download(PYTHON_URLS.win32, zipPath, pct => {
        onData?.(`Загрузка Python: ${pct}%`, 'in')
      })
      onData?.('Распаковываю Python…', 'in')
      await unzip(zipPath, PYTHON_DIR)
      fs.unlinkSync(zipPath)

      // Включаем pip в embeddable Python
      const pthFiles = fs.readdirSync(PYTHON_DIR).filter(f => f.endsWith('._pth'))
      for (const pth of pthFiles) {
        const p = path.join(PYTHON_DIR, pth)
        let c = fs.readFileSync(p, 'utf8')
        c = c.replace('#import site', 'import site')
        fs.writeFileSync(p, c)
      }

      // Скачать get-pip.py
      onData?.('Устанавливаю pip…', 'in')
      await download('https://bootstrap.pypa.io/get-pip.py', PIP_BOOTSTRAP)
      await spawnLogged(PYTHON_EXE, [PIP_BOOTSTRAP], { cwd: PYTHON_DIR }, onData)

      onData?.('Python 3.11 установлен', 'ok')
      return true
    } catch (e) {
      onData?.('Ошибка установки Python: ' + e.message, 'er')
      return false
    }
  }

  // ── Создать venv ───────────────────────────────────────────
  async ensureVenv(appId, onData) {
    if (hasVenv(appId)) { onData?.(`venv [${appId}] уже существует`, 'o'); return true }
    const py  = getPythonExe()
    const dir = getVenvDir(appId)
    onData?.(`Создаю виртуальную среду [${appId}]…`, 'in')
    const code = await spawnLogged(py, ['-m', 'venv', dir], {}, onData)
    if (code === 0) { onData?.(`venv [${appId}] создан`, 'ok'); return true }
    onData?.(`Ошибка создания venv [${appId}]`, 'er'); return false
  }

  // ── pip install в venv ─────────────────────────────────────
  async pipInstall(appId, packages, cwd, onData) {
    const pip = getVenvPip(appId)
    const pkgs = Array.isArray(packages) ? packages : [packages]
    onData?.(`pip install ${pkgs.join(' ')}`, 'in')
    return spawnLogged(
      pip,
      ['install', '--upgrade', ...pkgs],
      { cwd: cwd || this._appDir(appId) },
      onData
    )
  }

  // ── git clone ──────────────────────────────────────────────
  async gitClone(url, dest, onData) {
    onData?.(`git clone ${url}`, 'in')
    if (fs.existsSync(path.join(dest, '.git'))) {
      onData?.('Репозиторий уже существует, пропускаю clone', 'w')
      return 0
    }
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })
    return spawnLogged(getGitExe(), ['clone', '--depth=1', '--progress', url, '.'], { cwd: dest }, onData)
  }

  // ── git pull (обновление) ──────────────────────────────────
  async gitPull(appId, onData) {
    const dir = this._appDir(appId)
    if (!fs.existsSync(path.join(dir, '.git'))) {
      onData?.(`Нет git репозитория для ${appId}`, 'er'); return false
    }
    onData?.(`git pull [${appId}]…`, 'in')
    const code = await spawnLogged(getGitExe(), ['pull', '--rebase'], { cwd: dir }, onData)
    if (code === 0) { onData?.(`${appId} обновлён`, 'ok'); return true }
    onData?.(`Ошибка обновления ${appId}`, 'er'); return false
  }

  // ── Главная установка ──────────────────────────────────────
  async install(appId) {
    if (this.installing.has(appId)) return { ok: false, error: 'Уже устанавливается' }
    this.installing.add(appId)

    const sc = this._script(appId, 'install.json')
    if (!sc) { this.installing.delete(appId); return { ok: false, error: 'install.json не найден' } }

    const appDir = this._appDir(appId)
    if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true })

    const log_ = (m, t) => this._log(m, t, appId)
    log_(`═══ Установка ${sc.name || appId} ═══`, 'in')

    try {
      const steps = sc.run || []
      const total = steps.length + 2  // +2 за Python и venv
      let step    = 0

      // Шаг 0: Python
      this._progress(appId, ++step, total, Math.round(step/total*100), 'Проверка Python')
      const pyOk = await this.ensurePython(log_)
      if (!pyOk) throw new Error('Python недоступен')

      // Шаг 1: venv
      this._progress(appId, ++step, total, Math.round(step/total*100), 'Создание venv')
      await this.ensureVenv(appId, log_)

      // Шаги из install.json
      for (const s of steps) {
        this._progress(appId, ++step, total, Math.round(step/total*100), s.name || s.method)
        log_(`[${step}/${total}] ${s.name || ''}`, 'in')

        const cwd  = s.cwd ? path.join(appDir, s.cwd) : appDir
        const env_ = { ...process.env, ...(s.env || {}) }

        switch (s.method) {
          case 'git': {
            const url = s.url || s.command?.replace('git clone ', '').split(' ')[0]
            await this.gitClone(url, appDir, log_)
            break
          }
          case 'pip': {
            const pkgs = Array.isArray(s.packages) ? s.packages : s.packages?.split(' ') || []
            await this.pipInstall(appId, pkgs, cwd, log_)
            break
          }
          case 'shell': {
            // Подменяем python/pip на venv-версии
            let cmd = (s.command || '')
              .replace(/\bpython\b/g, getVenvPython(appId))
              .replace(/\bpython3\b/g, getVenvPython(appId))
              .replace(/\bpip\b/g, getVenvPip(appId))
              .replace(/\bpip3\b/g, getVenvPip(appId))
              .replace(/\{home\}/g, appDir)
            await spawnLogged(cmd, [], { cwd, shell: true, env: env_ }, log_)
            break
          }
          case 'npm': {
            const npmCmd = s.command || 'npm install'
            await spawnLogged(npmCmd, [], { cwd, shell: true }, log_)
            break
          }
          case 'download': {
            const dest_ = path.join(cwd, s.dest || path.basename(s.url))
            log_(`Скачиваю ${s.url}…`, 'in')
            await download(s.url, dest_, pct => {
              log_(`${s.name || 'Загрузка'}: ${pct}%`, 'in')
            })
            break
          }
        }
      }

      // Сохранить метку
      fs.writeFileSync(this._marker(appId), JSON.stringify({
        id: appId, name: sc.name,
        installedAt: new Date().toISOString(),
        version: sc.version || '1.0'
      }, null, 2))

      this._progress(appId, total, total, 100, 'Готово')
      log_(`✓ ${sc.name || appId} установлен`, 'ok')
      this.emit_('installed', { id: appId })
      return { ok: true }

    } catch (e) {
      log_(`✗ Ошибка установки: ${e.message}`, 'er')
      return { ok: false, error: e.message }
    } finally {
      this.installing.delete(appId)
    }
  }

  // ── Обновление ─────────────────────────────────────────────
  async update(appId) {
    const log_ = (m, t) => this._log(m, t, appId)
    log_(`Обновление ${appId}…`, 'in')
    const pulled = await this.gitPull(appId, log_)

    // Обновить pip зависимости
    const sc = this._script(appId, 'install.json')
    if (sc && pulled) {
      const reqFile = path.join(this._appDir(appId), 'requirements.txt')
      if (fs.existsSync(reqFile)) {
        await this.pipInstall(appId, ['-r', 'requirements.txt'], this._appDir(appId), log_)
      }
    }

    // Обновить метку версии
    if (pulled) {
      const meta = this.getInstalledMeta(appId)
      meta.updatedAt = new Date().toISOString()
      fs.writeFileSync(this._marker(appId), JSON.stringify(meta, null, 2))
    }

    return { ok: pulled }
  }

  // ── Запуск приложения ──────────────────────────────────────
  async launch(appId) {
    if (this.running[appId]) return { ok: false, error: 'Уже запущено' }

    const sc = this._script(appId, 'run.json')
    if (!sc) return { ok: false, error: 'run.json не найден' }

    const log_   = (m, t) => this._log(m, t, appId)
    const appDir = this._appDir(appId)
    const port   = await freePort(sc.port || 43010)

    // Подставить переменные в команду
    let cmd = (sc.command || '')
      .replace(/\{port\}/g, port)
      .replace(/\{home\}/g, appDir)
      .replace(/\bpython\b/g, getVenvPython(appId))
      .replace(/\bpython3\b/g, getVenvPython(appId))

    // Переменные среды
    const env = { ...process.env }
    for (const [k, v] of Object.entries(sc.env || {})) {
      env[k] = v.replace(/\{port\}/g, port).replace(/\{home\}/g, appDir)
    }

    log_(`▶ Запуск на порту ${port}…`, 'in')

    const [exe, ...args] = cmd.split(/\s+/)
    const proc = spawn(exe, args, {
      cwd: appDir, shell: true, env,
      detached: false,
    })

    this.running[appId] = { proc, port, pid: proc.pid, startedAt: new Date().toISOString() }

    proc.stdout?.on('data', d => { const s = d.toString().trim(); if (s) log_(s, 'o') })
    proc.stderr?.on('data', d => { const s = d.toString().trim(); if (s) log_(s, 'w') })
    proc.on('exit', code => {
      delete this.running[appId]
      log_(`■ Завершён (код ${code})`, code ? 'er' : 'o')
      this.emit_('stopped', { id: appId, code })
    })

    log(`Запущен ${appId} PID=${proc.pid} PORT=${port}`)
    return { ok: true, port, pid: proc.pid }
  }

  // ── Остановка ──────────────────────────────────────────────
  stop(appId) {
    const e = this.running[appId]
    if (!e) return { ok: false, error: 'Не запущено' }
    try {
      if (IS_WIN) exec(`taskkill /PID ${e.pid} /T /F`)
      else e.proc.kill('SIGTERM')
      delete this.running[appId]
      this._log(`${appId} остановлен`, 'w', appId)
      this.emit_('stopped', { id: appId })
      return { ok: true }
    } catch (err) { return { ok: false, error: err.message } }
  }

  stopAll() {
    for (const id of Object.keys(this.running)) this.stop(id)
  }

  // ── Удаление ───────────────────────────────────────────────
  uninstall(appId) {
    this.stop(appId)
    try { fs.rmSync(this._appDir(appId),  { recursive: true, force: true }) } catch {}
    try { fs.rmSync(getVenvDir(appId),     { recursive: true, force: true }) } catch {}
    this._log(`${appId} удалён`, 'w', appId)
    return { ok: true }
  }

  // ── Статус ─────────────────────────────────────────────────
  getRunning() {
    return Object.fromEntries(
      Object.entries(this.running).map(([k, v]) => [k, { port: v.port, pid: v.pid, startedAt: v.startedAt }])
    )
  }

  // ── Проверка обновлений через git remote ───────────────────
  async checkUpdate(appId) {
    const dir = this._appDir(appId)
    if (!fs.existsSync(path.join(dir, '.git'))) return { hasUpdate: false }
    try {
      execSync('git fetch --dry-run', { cwd: dir, stdio: 'ignore' })
      const local  = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim()
      const remote = execSync('git rev-parse @{u}', { cwd: dir }).toString().trim()
      return { hasUpdate: local !== remote }
    } catch { return { hasUpdate: false } }
  }

  // ── Системная информация ───────────────────────────────────
  getSystemInfo() {
    return {
      platform:  process.platform,
      arch:      process.arch,
      nodeVer:   process.version,
      pythonOk:  hasPython(),
      pythonExe: getPythonExe(),
      gitOk:     (() => { try { execSync('git --version', { stdio: 'ignore' }); return true } catch { return false } })(),
      freeRAM:   Math.round(os.freemem() / 1024 / 1024),
      totalRAM:  Math.round(os.totalmem() / 1024 / 1024),
      homeDir:   HOME_DIR,
      appsDir:   APPS_DIR_,
      venvDir:   VENV_DIR,
    }
  }
}

module.exports = { Engine, HOME_DIR, APPS_DIR_, VENV_DIR, LOG_DIR, LOG_FILE, getPythonExe, hasPython }
