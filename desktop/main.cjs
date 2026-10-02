const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { openStore } = require('./store.cjs');
const { startServer, PORT } = require('./server.cjs');

app.setName('MisGastos');
app.setAppUserModelId('ar.misgastos.app');
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let mainWindow = null;
let tray = null;
let server = null;
let store = null;
let quitting = false;
const root = path.resolve(__dirname, '..');

function showWindow(openQr = false) {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.restore();
  mainWindow.focus();
  if (openQr) mainWindow.webContents.executeJavaScript('window.MISGASTOS_OPEN_QR && window.MISGASTOS_OPEN_QR()').catch(() => {});
}

function loginSettings(enabled) {
  if (!app.isPackaged || process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] });
}

function setupLogin() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const configured = path.join(app.getPath('userData'), 'autostart-configured');
  if (!fs.existsSync(configured)) {
    loginSettings(true);
    fs.writeFileSync(configured, '1');
  }
}

function trayMenu() {
  const auto = app.isPackaged && process.platform === 'win32' && app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir MisGastos', click: () => showWindow() },
    { label: 'Conectar iPhone', click: () => showWindow(true) },
    { type: 'separator' },
    { label: 'Iniciar con Windows', type: 'checkbox', checked: Boolean(auto), enabled: app.isPackaged && process.platform === 'win32', click: (item) => { loginSettings(item.checked); trayMenu(); } },
    { type: 'separator' },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } }
  ]));
}

function createWindow() {
  const icon = path.join(root, 'assets', 'misgastos-logo.png');
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: 'MisGastos',
    icon,
    show: false,
    backgroundColor: '#f6f4f0',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });
  mainWindow.loadURL('http://127.0.0.1:' + PORT + '/');
  mainWindow.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) mainWindow.show(); });
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

app.on('second-instance', () => showWindow());
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    const userData = app.getPath('userData');
    store = await openStore(userData, path.join(root, 'initial-state.json'));
    const started = await startServer(store, root, () => {
      showWindow();
      if (mainWindow) mainWindow.webContents.executeJavaScript('window.MISGASTOS_PENDING && window.MISGASTOS_PENDING()').catch(() => {});
    });
    server = started.server;
    createWindow();
    const icon = nativeImage.createFromPath(path.join(root, 'assets', 'misgastos-logo.png')).resize({ width: 20, height: 20 });
    tray = new Tray(icon);
    tray.setToolTip('MisGastos');
    tray.on('click', () => showWindow());
    trayMenu();
    setupLogin();
    trayMenu();
  } catch (error) {
    console.error('No se pudo iniciar MisGastos:', error);
    dialog.showErrorBox('MisGastos no pudo iniciarse', error.message + '\n\nSi el puerto 4174 está ocupado, cerrá la otra instancia.');
    app.quit();
  }
});

app.on('before-quit', () => { quitting = true; if (server) server.close(); if (store) store.close(); });
