const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const DEFAULT_DELAY_MS = 1000;

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getMarketplaceDir(homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir()) {
  return path.join(homeDir, '.claude', 'plugins', 'marketplaces', 'thedotmack');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const delayMs = Number(process.env.CLAUDE_MEM_DEV_SYNC_DELAY_MS ?? DEFAULT_DELAY_MS);
  const targetDir = getMarketplaceDir();

  if (!Number.isFinite(delayMs) || delayMs < 0) {
    console.warn(`Ignoring invalid CLAUDE_MEM_DEV_SYNC_DELAY_MS value: ${process.env.CLAUDE_MEM_DEV_SYNC_DELAY_MS}`);
  }

  if (!fs.existsSync(targetDir)) {
    console.warn(`Marketplace path not found; skipping worker restart: ${targetDir}`);
    return;
  }

  await wait(Math.max(0, Number.isFinite(delayMs) ? delayMs : DEFAULT_DELAY_MS));

  const result = spawnSync(getNpmCommand(), ['run', 'worker:restart'], {
    cwd: targetDir,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 0);
}

module.exports = {
  getNpmCommand,
  getMarketplaceDir,
  main,
};

if (require.main === module) {
  main().catch((error) => {
    console.error('dev-sync failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
