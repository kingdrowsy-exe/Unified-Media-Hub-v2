import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Electron otherwise names the userData folder after package.json's "name"
// (unified-media-hub-app) rather than the product name people actually see.
app.setName("Unified Media Hub");

// A fixed, uncommon port for the embedded server - distinct from the dev
// project's 4000 so both can run side by side without colliding.
const PORT = 4173;
process.env.PORT = String(PORT);

// Route settings.json (Plex/Silo/Xtream/TMDB/Trakt credentials) to Electron's
// proper per-user app-data folder, since the app's install directory isn't
// reliably writable.
process.env.DATA_DIR = path.join(app.getPath("userData"), "data");

let mainWindow = null;

async function createWindow() {
  const { startServer } = await import("../server/dist/index.js");
  await startServer();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0a12",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "../build/icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // 127.0.0.1 rather than localhost: the embedded server listens on IPv4
  // loopback only, and on some Windows setups "localhost" resolves to ::1.
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
