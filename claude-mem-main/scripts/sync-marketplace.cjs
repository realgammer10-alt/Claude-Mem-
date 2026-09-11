#!/usr/bin/env node

const { execSync } = require('child_process');
const { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } = require('fs');
const path = require('path');
const os = require('os');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');

// Reject obviously invalid ports before they reach http.request, which would
// throw with a confusing error like "RangeError: Port should be > 0 and < 65536".
function parseWorkerPort(value) {
  const port = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, '.git'))) {
      return null;
    }
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALLED_PATH,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

function getGitignoreExcludes(basePath) {
  const gitignorePath = path.join(basePath, '.gitignore');
  if (!existsSync(gitignorePath)) return [];

  const syncManagedFiles = new Set();

  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  return lines
    .map(line => line.trim())
    .filter(line =>
      line &&
      !line.startsWith('#') &&
      !line.startsWith('!') &&
      !syncManagedFiles.has(line)
    )
    .map(pattern => pattern.replace(/\\/g, '/'));
}

function matchesExclude(relativePath, patterns) {
  const normalized = relativePath.replace(/\\/g, '/');
  const basename = path.posix.basename(normalized);
  return patterns.some(pattern => {
    const clean = pattern.replace(/^\/+/, '').replace(/\/$/, '');
    if (!clean) return false;
    if (clean.includes('*')) {
      const expression = new RegExp(`^${clean.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}(?:/|$)`);
      return expression.test(normalized) || expression.test(basename);
    }
    return clean.includes('/')
      ? normalized === clean || normalized.startsWith(`${clean}/`)
      : basename === clean || normalized === clean;
  });
}

function syncDirectory(sourceDir, destinationDir, excludedPatterns) {
  mkdirSync(destinationDir, { recursive: true });

  function removeStale(destinationPath) {
    const relativePath = path.relative(destinationDir, destinationPath);
    if (matchesExclude(relativePath, excludedPatterns)) return;

    const sourcePath = path.join(sourceDir, relativePath);
    if (!existsSync(sourcePath)) {
      rmSync(destinationPath, { recursive: true, force: true });
      return;
    }

    if (statSync(destinationPath).isDirectory() && statSync(sourcePath).isDirectory()) {
      for (const entry of readdirSync(destinationPath)) {
        removeStale(path.join(destinationPath, entry));
      }
    }
  }

  for (const entry of readdirSync(destinationDir)) {
    removeStale(path.join(destinationDir, entry));
  }

  cpSync(sourceDir, destinationDir, {
    recursive: true,
    filter: sourcePath => {
      const relativePath = path.relative(sourceDir, sourcePath);
      return !relativePath || !matchesExclude(relativePath, excludedPatterns);
    },
  });
}

function installDependencies(directory) {
  execSync('bun install', { cwd: directory, stdio: 'inherit' });
}

const branch = getCurrentBranch();
const isForce = process.argv.includes('--force');

if (branch && branch !== 'main' && !isForce) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
  console.log('\x1b[33m%s\x1b[0m', 'Running rsync would overwrite beta code.');
  console.log('');
  console.log('Options:');
  console.log('  1. Use UI at http://localhost:37777 to update beta');
  console.log('  2. Switch to stable in UI first, then run sync');
  console.log('  3. Force rsync: npm run sync-marketplace:force');
  console.log('');
  process.exit(1);
}

function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Failed to read plugin version:', error.message);
    process.exit(1);
  }
}

function detectInstalledVersion(buildVersion) {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), '.claude-mem');
  const settingsPath = path.join(dataDir, 'settings.json');
  let port = parseWorkerPort(process.env.CLAUDE_MEM_WORKER_PORT);
  if (!port && existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const settingsPort = parseWorkerPort(s.CLAUDE_MEM_WORKER_PORT);
      if (settingsPort) port = settingsPort;
    } catch {}
  }
  if (!port) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 77;
    port = 37700 + (uid % 100);
  }
  let healthBody;
  try {
    healthBody = execSync(`curl -s --max-time 2 http://127.0.0.1:${port}/api/health`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return null;
  }
  if (!healthBody) return null;
  let installedVersion;
  let installedPath;
  try {
    const j = JSON.parse(healthBody);
    installedVersion = j.version;
    installedPath = j.workerPath;
  } catch {
    return null;
  }
  if (!installedVersion || installedVersion === buildVersion) return null;
  return { installedVersion, installedPath };
}

const installedMismatch = detectInstalledVersion(getPluginVersion());
if (installedMismatch) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', 'Version mismatch detected:');
  console.log(`  Building:   ${getPluginVersion()}`);
  console.log(`  Installed:  ${installedMismatch.installedVersion}`);
  if (installedMismatch.installedPath) console.log(`  Worker path: ${installedMismatch.installedPath}`);
  console.log('');
  console.log('Claude Code is pinned to the installed version, so the worker loads from');
  console.log(`its cache dir. Mirroring this build into the installed-version cache so the`);
  console.log('worker restart picks up new code without a Claude Code session restart.');
  console.log('');
  console.log('\x1b[36m%s\x1b[0m', `For a formal version bump, run \`claude plugin update thedotmack/claude-mem\``);
  console.log('\x1b[36m%s\x1b[0m', `and restart Claude Code so it loads the ${getPluginVersion()} cache dir.`);
  console.log('');
}

console.log('Syncing to marketplace...');
try {
  const rootDir = path.join(__dirname, '..');
  const gitignoreExcludes = [
    ...getGitignoreExcludes(rootDir),
    '.git',
    'bun.lock',
    'package-lock.json',
    'scripts/package.json',
    'scripts/node_modules',
  ];
  syncDirectory(rootDir, INSTALLED_PATH, gitignoreExcludes);

  console.log('Running bun install in marketplace...');
  installDependencies(INSTALLED_PATH);

  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  const pluginDir = path.join(rootDir, 'plugin');
  const pluginGitignoreExcludes = [...getGitignoreExcludes(pluginDir), '.git'];

  console.log(`Syncing to cache folder (version ${version})...`);
  syncDirectory(pluginDir, CACHE_VERSION_PATH, pluginGitignoreExcludes);

  console.log(`Running bun install in cache folder (version ${version})...`);
  installDependencies(CACHE_VERSION_PATH);

  if (installedMismatch && installedMismatch.installedVersion !== version) {
    const INSTALLED_CACHE_PATH = path.join(CACHE_BASE_PATH, installedMismatch.installedVersion);
    console.log(`Mirroring to installed-version cache (${installedMismatch.installedVersion}) for hot reload...`);
    syncDirectory(pluginDir, INSTALLED_CACHE_PATH, pluginGitignoreExcludes);
    console.log(`Running bun install in installed-version cache (${installedMismatch.installedVersion})...`);
    installDependencies(INSTALLED_CACHE_PATH);
  }

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

  console.log('\n🔄 Triggering worker restart...');
  const http = require('http');
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), '.claude-mem');
  const settingsPath = path.join(dataDir, 'settings.json');
  let settingsPort = null;
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      settingsPort = parseWorkerPort(settings.CLAUDE_MEM_WORKER_PORT);
    } catch {
      // fall through to env / default
    }
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 77;
  const defaultPort = 37700 + (uid % 100);
  const workerPort =
    parseWorkerPort(process.env.CLAUDE_MEM_WORKER_PORT) ??
    settingsPort ??
    defaultPort;
  const req = http.request({
    hostname: '127.0.0.1',
    port: workerPort,
    path: '/api/admin/restart',
    method: 'POST',
    timeout: 2000
  }, (res) => {
    if (res.statusCode === 200) {
      console.log('\x1b[32m%s\x1b[0m', `✓ Worker restart triggered on port ${workerPort}`);
    } else {
      console.log('\x1b[33m%s\x1b[0m', `ℹ Worker restart on port ${workerPort} returned status ${res.statusCode}`);
    }
  });
  req.on('error', () => {
    console.log('\x1b[33m%s\x1b[0m', `ℹ No worker reachable on port ${workerPort}; the next worker:restart step will start one.`);
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('\x1b[33m%s\x1b[0m', `ℹ Worker restart on port ${workerPort} timed out`);
  });
  req.end();

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}
