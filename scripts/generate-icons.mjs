import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const rootDir = process.cwd();
const sourcePath = process.argv[2] ?? 'C:/Users/guzel/Desktop/Gifferlogos.png';
const publicDir = path.join(rootDir, 'public');
const electronAssetsDir = path.join(rootDir, 'electron', 'assets');

async function main() {
  await mkdir(publicDir, { recursive: true });
  await mkdir(electronAssetsDir, { recursive: true });

  const favicon512Path = path.join(publicDir, 'favicon-512.png');
  const favicon256Path = path.join(publicDir, 'favicon-256.png');
  const favicon128Path = path.join(publicDir, 'favicon-128.png');
  const favicon64Path = path.join(publicDir, 'favicon-64.png');
  const favicon32Path = path.join(publicDir, 'favicon-32.png');
  const favicon16Path = path.join(publicDir, 'favicon-16.png');
  const faviconIcoPath = path.join(publicDir, 'favicon.ico');
  const electronPngPath = path.join(electronAssetsDir, 'giffer.png');
  const electronIcoPath = path.join(electronAssetsDir, 'giffer.ico');

  await copyFile(sourcePath, electronPngPath);
  await sharp(sourcePath).resize(512, 512, { fit: 'contain', background: '#000000' }).png().toFile(favicon512Path);
  await sharp(sourcePath).resize(256, 256, { fit: 'contain', background: '#000000' }).png().toFile(favicon256Path);
  await sharp(sourcePath).resize(128, 128, { fit: 'contain', background: '#000000' }).png().toFile(favicon128Path);
  await sharp(sourcePath).resize(64, 64, { fit: 'contain', background: '#000000' }).png().toFile(favicon64Path);
  await sharp(sourcePath).resize(32, 32, { fit: 'contain', background: '#000000' }).png().toFile(favicon32Path);
  await sharp(sourcePath).resize(16, 16, { fit: 'contain', background: '#000000' }).png().toFile(favicon16Path);

  const icoBuffer = await pngToIco([
    favicon16Path,
    favicon32Path,
    favicon64Path,
    favicon128Path,
    favicon256Path,
  ]);

  await Promise.all([writeFile(faviconIcoPath, icoBuffer), writeFile(electronIcoPath, icoBuffer)]);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
