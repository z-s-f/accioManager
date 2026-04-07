const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

// 1. Determine writable data directory
const userDataPath = app.getPath('userData');
const appDataPath = path.join(userDataPath, 'data');

// Simple sync data initialization to avoid async hanging issues
function initializeDataSync() {
  try {
    if (!fs.existsSync(appDataPath)) {
      fs.mkdirSync(appDataPath, { recursive: true });
    }

    const metaSource = path.join(__dirname, 'data', 'accounts_meta.json');
    const metaDest = path.join(appDataPath, 'accounts_meta.json');
    
    // Quick check if we need to seed data
    if (!fs.existsSync(metaDest) && fs.existsSync(metaSource)) {
      console.log('[Main] Seeding data from bundle...');
      // Just copy the main meta file if nothing exists
      fs.copyFileSync(metaSource, metaDest);
      
      // Attempt to copy others if directories exist
      const profilesSource = path.join(__dirname, 'data', 'profiles');
      const profilesDest = path.join(appDataPath, 'profiles');
      if (fs.existsSync(profilesSource) && !fs.existsSync(profilesDest)) {
        fs.mkdirSync(profilesDest, { recursive: true });
        // Minimal seed, server.js will handle the rest via ensureDataDir
      }
    }
  } catch (err) {
    console.error('[Main] Data initialization error:', err);
  }
}

// Start server and wait until it's actually listening before resolving
function startServerAndWait() {
  return new Promise((resolve, reject) => {
    process.env.ACCIO_MANAGER_DATA_DIR = appDataPath;
    process.env.PORT = '3000';
    process.env.NODE_ENV = 'production';
    // Signal to server.js that it should call back when ready
    process.env.ELECTRON_SERVER_READY_CB = '1';

    try {
      console.log('[Main] Starting Express server...');
      const server = require('./server.js');
      // server.js exports the http.Server instance so we can hook 'listening'
      if (server && typeof server.on === 'function') {
        if (server.listening) {
          console.log('[Main] Server already listening.');
          resolve();
        } else {
          server.once('listening', () => {
            console.log('[Main] Server is now listening — creating window.');
            resolve();
          });
          server.once('error', reject);
        }
      } else {
        // Fallback: server doesn't export an http.Server — give it a moment
        console.warn('[Main] server.js did not export http.Server, falling back to 300ms delay.');
        setTimeout(resolve, 300);
      }
    } catch (err) {
      console.error('[Main] Server require failed:', err);
      reject(err);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    title: 'Accio Manager',
    backgroundColor: '#0a0b0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'hidden',
    show: false
  });

  // Load the local UI — server is already up at this point
  const indexPath = path.join(__dirname, 'public', 'index.html');
  console.log('[Main] Loading UI from:', indexPath);
  
  if (fs.existsSync(indexPath)) {
    mainWindow.loadFile(indexPath).catch(err => {
      console.error('[Main] Failed to load index.html:', err);
    });
  } else {
    console.error('[Main] index.html NOT FOUND at:', indexPath);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Intercept new window openings for OAuth
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Generate a randomized fingerprint for this specific session
    const randomAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ];
    const userAgent = randomAgents[Math.floor(Math.random() * randomAgents.length)];
    
    // Use a random session partition to prevent cookie bleeding (Anti-Detect)
    const sessionId = `accio_auth_${Date.now()}`;

    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        backgroundColor: '#0a0b0f',
        show: false, // Start hidden — only show when content is ready
        userAgent: userAgent,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: sessionId // Non-persistent: fresh empty session every time, no cookie bleed
        }
      }
    };
  });

  // Catch navigation to the callback URL in any window
  // Also handle child window lifecycle (prevent permanent black screens)
  app.on('browser-window-created', (e, win) => {
    // Skip the main window — it has its own ready-to-show handler above
    if (win === mainWindow) return;

    // ── Anti auto-login: block requests to Accio desktop's local auth server ──
    // Accio's web login page checks localhost:4097 to detect the currently
    // logged-in desktop user and auto-fills the session. Block this so each
    // OAuth window always shows a clean, unauthenticated login form.
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://localhost:4097/*', 'http://127.0.0.1:4097/*'] },
      (details, callback) => {
        console.log('[Auth Window] Blocked local auth probe:', details.url);
        callback({ cancel: true });
      }
    );

    // Show child window only when content is ready (prevents black screen flash)
    win.once('ready-to-show', () => {
      win.show();
    });

    // If the page fails to load, show a simple error page instead of black screen
    win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return; // Aborted/cancelled navigation — ignore
      console.error(`[Child Window] Failed to load: ${validatedURL} — ${errorDescription} (${errorCode})`);
      win.webContents.loadURL(
        `data:text/html;charset=utf-8,<html><body style="background:%230a0b0f;color:%23aaa;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center"><p style="font-size:18px">页面加载失败</p><p style="font-size:13px;opacity:.6">${errorDescription}</p><p style="font-size:12px;opacity:.4">${validatedURL}</p></div></body></html>`
      ).catch(() => {}).finally(() => win.show());
    });

    // ── Auto-dismiss the SSO "existing account" prompt ──
    // Accio/Alibaba SSO remembers the last logged-in user on the server side
    // (independent of cookies). When the login page loads with an "existing
    // account" pre-filled, we automatically click "Sign in with another account"
    // so the user always gets a clean, blank login form.
    win.webContents.on('did-finish-load', async () => {
      const url = win.webContents.getURL();
      // Only run on Accio or Alibaba SSO domains
      if (!url.includes('accio.com') && !url.includes('alibaba')) return;

      try {
        const clicked = await win.webContents.executeJavaScript(`
          (function dismissExistingAccountPrompt() {
            // Find the "Sign in with another account" link/button
            var all = document.querySelectorAll('a, button, span');
            for (var el of all) {
              var text = (el.innerText || el.textContent || '').trim().toLowerCase();
              if (
                text.includes('another account') ||
                text.includes('sign in with another') ||
                text.includes('use another') ||
                text.includes('switch account')
              ) {
                el.click();
                return true;
              }
            }
            return false;
          })();
        `);
        if (clicked) {
          console.log('[Auth Window] Auto-dismissed existing account prompt.');
        }
      } catch (e) {
        // Cross-origin or page not ready — ignore
      }
    });

    win.webContents.on('will-navigate', (event, url) => {
      handleNav(url, win);
    });
    win.webContents.on('did-navigate', (event, url) => {
      handleNav(url, win);
    });
  });

  function handleNav(url, win) {
    if (url.includes('/auth/callback') && url.includes('accessToken=')) {
      console.log('[Main] Detected OAuth callback in window, importing automatically...');
      // Notify the frontend to refresh
      if (mainWindow) {
        mainWindow.webContents.send('oauth-success', { url });
      }
      // Auto-close the auth window after the callback is captured
      // so stale "logged-in" windows don't accumulate
      setTimeout(() => {
        if (!win.isDestroyed()) win.close();
      }, 1500);
    }
  }
}

// Window IPC controls
ipcMain.on('window-minimize', () => { if(mainWindow) mainWindow.minimize(); });
ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});
ipcMain.on('window-close', () => { if(mainWindow) mainWindow.close(); });
ipcMain.handle('window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);
ipcMain.handle('select-directory', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// Electron App Lifecycle
app.whenReady().then(async () => {
  // Step 1: Seed data files (sync, fast)
  initializeDataSync();

  // Step 2: Start Express and wait until it's listening
  try {
    await startServerAndWait();
  } catch (err) {
    console.error('[Main] Server failed to start:', err);
    // Still create window so user sees the UI, loadAll retry will handle it
  }

  // Step 3: Create window — server is guaranteed to be up
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
