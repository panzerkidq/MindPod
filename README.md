# MindPod v1.0

Локальный лаунчер AI-приложений с glassmorphism UI.
Поддерживает 67+ приложений и 120+ LLM-моделей через Ollama.

## Быстрый старт

```bash
npm install
npm start
```

## Сборка

```bash
npm install
npm run build
```

Собранные файлы будут в папке `dist/`.

## Требования

- Node.js 18+
- npm 8+
- Python 3.10+ (для AI-приложений)
- Git

## Структура проекта

```
MindPod/
├── main.js          - Electron main process
├── preload.js       - IPC bridge
├── engine.js        - Движок установки/запуска
├── package.json
├── src/
│   └── renderer/
│       └── index.html   - UI (весь фронтенд)
└── apps/            - JSON-скрипты приложений
    ├── ollama/
    ├── comfyui/
    └── ...
```

## Публикация на GitHub

```bash
git init
git add .
git commit -m "MindPod v1.0"
git remote add origin https://github.com/YOUR_USERNAME/mindpod.git
git push -u origin main
```

## Лицензия

MIT
