import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const builderDir = path.join(rootDir, 'release', 'builder');
const expectedArtifacts = [
  path.join(builderDir, 'win-unpacked'),
  path.join(builderDir, 'Giffer Setup 0.1.0.exe'),
];

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      shell: true,
      stdio: 'inherit',
      ...options,
    });

    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function artifactsExist() {
  for (const artifactPath of expectedArtifacts) {
    try {
      await access(artifactPath);
    } catch {
      return false;
    }
  }

  return true;
}

async function main() {
  const buildCode = await runCommand('npm.cmd', ['run', 'build']);

  if (buildCode !== 0) {
    process.exitCode = buildCode;
    return;
  }

  const builderCode = await runCommand('electron-builder', [], {
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  });

  if (builderCode !== 0) {
    const producedArtifacts = await artifactsExist();

    if (!producedArtifacts) {
      process.exitCode = builderCode;
      return;
    }
  }

  const syncCode = await runCommand('node', ['scripts/sync-artifacts.mjs']);
  process.exitCode = syncCode;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
