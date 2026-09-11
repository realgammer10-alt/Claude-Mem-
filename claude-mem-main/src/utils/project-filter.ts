
import { homedir } from 'os';
import { basename } from 'path';
import { logger } from './logger.js';

function globToRegex(pattern: string): RegExp {
  let expanded = pattern.startsWith('~')
    ? homedir() + pattern.slice(1)
    : pattern;

  expanded = expanded.replace(/\\/g, '/');
  const isRootPattern = expanded === '/' || /^[A-Za-z]:\/$/.test(expanded);
  if (!isRootPattern) {
    expanded = expanded.replace(/\/+$/, '') || '/';
  }
  const hasTrailingGlobstar = expanded.endsWith('/**');
  if (hasTrailingGlobstar) {
    expanded = expanded.slice(0, -3);
  }

  let regex = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const globstarPrefixToken = '\u0000GLOBSTAR_PREFIX\u0000';
  const globstarSegmentsToken = '\u0000GLOBSTAR_SEGMENTS\u0000';
  const globstarToken = '\u0000GLOBSTAR\u0000';

  regex = regex
    .replace(/^\*\*\//g, globstarPrefixToken)
    .replace(/\/\*\*\//g, globstarSegmentsToken)
    .replace(/\*\*/g, globstarToken)
    .replace(/\*/g, '[^/]*')              
    .replace(/\?/g, '[^/]')               
    .replaceAll(globstarToken, '.*')
    .replaceAll(globstarSegmentsToken, '(?:/[^/]+)*/')
    .replaceAll(globstarPrefixToken, '(?:.*/)?');

  return new RegExp(`^${regex}${hasTrailingGlobstar ? '(?:/.*)?' : ''}$`);
}

function matchesGlobPatterns(folderPath: string, patterns: string[]): boolean {
  const normalizedPath = folderPath.replace(/\\/g, '/');
  const pathWithoutTrailingSeparators = normalizedPath.replace(/\/+$/, '');
  const isRootPath = normalizedPath === '/' || /^[A-Za-z]:\/$/.test(normalizedPath);
  const comparablePath = isRootPath ? normalizedPath : pathWithoutTrailingSeparators || '/';
  const pathBasename = basename(comparablePath);

  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim();
    if (!pattern) continue;
    try {
      const regex = globToRegex(pattern);
      if (regex.test(comparablePath) || regex.test(pathBasename)) {
        return true;
      }
    } catch (error: unknown) {
      logger.warn('PROJECT_NAME', 'Invalid glob pattern', { pattern, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return false;
}

/**
 * Returns true when `folderPath` matches any of the supplied glob patterns.
 * Patterns support `*`, `**`, `?`, and a leading `~`. Matches against both the
 * full normalized path and the basename. Reuses the same glob semantics as
 * project exclusion. Used by the skeleton-CLAUDE.md deny-list (#2400).
 */
export function matchesAnyGlob(folderPath: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  return matchesGlobPatterns(folderPath, patterns);
}

export function isProjectExcluded(projectPath: string, exclusionPatterns: string): boolean {
  if (!exclusionPatterns || !exclusionPatterns.trim()) {
    return false;
  }

  const patternList = exclusionPatterns
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  return matchesGlobPatterns(projectPath, patternList);
}
