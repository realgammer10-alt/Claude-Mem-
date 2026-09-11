#!/usr/bin/env node
/**
 * Rejects the plugin-root placeholder in shell examples.
 *
 * `${CLAUDE_PLUGIN_ROOT}` is valid in hook configuration JSON, but shell
 * examples cannot rely on the host to expand it. Keep shell snippets portable
 * by using the generated command form instead.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_ROOT = path.join(REPO_ROOT, 'docs', 'public');
const FORBIDDEN = '${CLAUDE_PLUGIN_ROOT}';

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.mdx')) files.push(fullPath);
  }
  return files;
}

function scanFile(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const violations = [];
  let shellFence = false;

  lines.forEach((line, index) => {
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      if (shellFence) shellFence = false;
      else shellFence = /^(bash|sh)$/i.test(fence[1]);
      return;
    }
    if (shellFence && line.includes(FORBIDDEN)) {
      violations.push({ file: filePath, line: index + 1 });
    }
  });

  return violations;
}

function findViolations(root = DOCS_ROOT) {
  return walk(root).flatMap(scanFile);
}

function run() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log('docs shell placeholder lint: OK');
    return 0;
  }

  console.error('docs shell placeholder lint failed: use generated commands in bash/sh examples:');
  for (const violation of violations) {
    console.error(`  ${path.relative(REPO_ROOT, violation.file)}:${violation.line} contains ${FORBIDDEN}`);
  }
  return 1;
}

module.exports = { findViolations, scanFile };

if (require.main === module) process.exit(run());
