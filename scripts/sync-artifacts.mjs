import { copyFile, cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const releaseRootDir = path.join(rootDir, 'release');
const builderDir = path.join(releaseRootDir, 'builder');
const webDir = path.join(releaseRootDir, 'web');
const windowsDir = path.join(releaseRootDir, 'windows');
const itchDir = path.join(releaseRootDir, 'itch');
const rootMetadataFiles = ['app.manifest.json', 'AI.md', 'CHANGELOG.md', 'llms.txt'];
const releaseLegacyEntries = ['win-unpacked', 'builder-debug.yml', 'Giffer 0.1.0.exe', 'Giffer Setup 0.1.0.exe', 'Giffer Setup 0.1.0.exe.blockmap'];
const rootLegacyDirs = ['web', 'windows', 'itch', 'web app', 'windows app', 'itch build'].map((dirName) =>
  path.join(rootDir, dirName),
);

async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
}

async function safeRemove(targetPath) {
  try {
    await rm(targetPath, { recursive: true, force: true });
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EPERM') {
      console.warn(`Silinemedi (kilitli): ${targetPath}`);
      return;
    }

    throw error;
  }
}

async function resetDirectory(targetDir) {
  await ensureDirectory(targetDir);
  const entries = await readdir(targetDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(targetDir, entry.name);
    await safeRemove(entryPath);
  }
}

async function copyDirectoryContents(sourceDir, targetDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    await cp(sourcePath, targetPath, { recursive: true, force: true });
  }
}

async function copyNamedFile(sourcePath, targetPath) {
  await ensureDirectory(path.dirname(targetPath));
  await copyFile(sourcePath, targetPath);
}

async function ensureBuildOutputs() {
  for (const directory of [distDir, builderDir]) {
    try {
      const directoryStat = await stat(directory);

      if (!directoryStat.isDirectory()) {
        throw new Error();
      }
    } catch {
      throw new Error(`Beklenen build cikti klasoru bulunamadi: ${directory}`);
    }
  }
}

async function main() {
  await ensureBuildOutputs();
  await Promise.all(rootLegacyDirs.map((directory) => safeRemove(directory)));
  await Promise.all([resetDirectory(webDir), resetDirectory(windowsDir), resetDirectory(itchDir)]);

  await copyDirectoryContents(distDir, webDir);
  await Promise.all(rootMetadataFiles.map((fileName) => copyNamedFile(path.join(rootDir, fileName), path.join(webDir, fileName))));
  await cp(path.join(rootDir, 'metadata'), path.join(webDir, 'metadata'), { recursive: true, force: true });
  await copyNamedFile(path.join(builderDir, 'Giffer 0.1.0.exe'), path.join(windowsDir, 'Giffer.exe'));
  await copyNamedFile(path.join(builderDir, 'Giffer Setup 0.1.0.exe'), path.join(itchDir, 'Giffer Setup.exe'));
  await safeRemove(builderDir);
  await Promise.all(releaseLegacyEntries.map((entryName) => safeRemove(path.join(releaseRootDir, entryName))));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
