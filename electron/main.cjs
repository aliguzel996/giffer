const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const DEV_URL = 'http://127.0.0.1:4173/';
const APP_ICON_PATH = path.join(__dirname, 'assets', 'giffer.ico');

const MIME_BY_EXTENSION = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

function guessMimeType(filePath) {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#f4f6f8',
    autoHideMenuBar: true,
    title: 'Giffer',
    icon: APP_ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (app.isPackaged) {
    window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    window.loadURL(process.env.ELECTRON_RENDERER_URL ?? DEV_URL);
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return window;
}

app.whenReady().then(() => {
  ipcMain.handle('desktop:is-available', () => true);

  ipcMain.handle('desktop:open-media', async (_, mode = 'images') => {
    const isVideoMode = mode === 'video';
    const result = await dialog.showOpenDialog({
      properties: isVideoMode ? ['openFile'] : ['openFile', 'multiSelections'],
      filters: [
        isVideoMode
          ? {
              name: 'Videos',
              extensions: ['mp4', 'mov', 'webm', 'm4v'],
            }
          : {
              name: 'Images',
              extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'],
            },
      ],
    });

    if (result.canceled) {
      return [];
    }

    return Promise.all(
      result.filePaths.map(async (filePath) => {
        const stats = await fs.stat(filePath);
        const mimeType = guessMimeType(filePath);

        if (!isVideoMode) {
          return {
            name: path.basename(filePath),
            path: filePath,
            size: stats.size,
            type: mimeType,
          };
        }

        const fileBytes = await fs.readFile(filePath);

        return {
          dataUrl: `data:${mimeType};base64,${fileBytes.toString('base64')}`,
          name: path.basename(filePath),
          path: filePath,
          size: stats.size,
          type: mimeType,
        };
      }),
    );
  });

  ipcMain.handle('desktop:save-export', async (_, payload) => {
    const { defaultExtension, fileBytes, suggestedName } = payload;
    const result = await dialog.showSaveDialog({
      defaultPath: suggestedName,
      filters: [
        {
          name: defaultExtension.toUpperCase(),
          extensions: [defaultExtension],
        },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    await fs.writeFile(result.filePath, Buffer.from(fileBytes));

    return {
      canceled: false,
      filePath: result.filePath,
    };
  });

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
