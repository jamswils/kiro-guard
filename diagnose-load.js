// Standalone Electron diagnostic. Loads lock.html directly with verbose error output.
// Run with: node_modules\electron\dist\electron.exe diagnose-load.js

const { app, BrowserWindow } = require('electron')
const path = require('path')

app.whenReady().then(async () => {
  const lockHtml = path.join(__dirname, 'dist', 'renderer', 'lock.html')
  console.log('[diag] Attempting to load:', lockHtml)
  console.log('[diag] File exists:', require('fs').existsSync(lockHtml))

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[diag] did-fail-load:', code, desc, url)
  })

  win.webContents.on('console-message', (_e, level, msg) => {
    console.log('[diag] renderer console:', level, msg)
  })

  try {
    await win.loadFile(lockHtml)
    console.log('[diag] loadFile resolved OK')
  } catch (err) {
    console.error('[diag] loadFile rejected:', err.message)
    console.error('[diag] Full error:', err)
  }

  // Keep window open 15 seconds for inspection then quit
  setTimeout(() => app.quit(), 15000)
})
