
import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { toBmpSafe } from './bmp-safe.js';

export const CONTEXT_TAG_OPEN = '<claude-mem-context>';
export const CONTEXT_TAG_CLOSE = '</claude-mem-context>';

function findContextBlockEnd(content: string, startIndex: number): number {
  const tagPattern = /<\/claude-mem-context>|<claude-mem-context\b[^>]*>/g;
  tagPattern.lastIndex = startIndex;
  let depth = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(content)) !== null) {
    if (match[0] !== CONTEXT_TAG_CLOSE) {
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) {
        return match.index + CONTEXT_TAG_CLOSE.length;
      }
    }
  }

  return -1;
}

export function injectContextIntoMarkdownFile(
  filePath: string,
  contextContent: string,
  headerLine?: string,
): void {
  const parentDirectory = path.dirname(filePath);
  mkdirSync(parentDirectory, { recursive: true });

  // #2787: strip astral (surrogate-pair) code points so a Claude Code context
  // truncation can't split a pair into a lone surrogate and brick the session.
  const safeContent = toBmpSafe(contextContent)
    .replaceAll(CONTEXT_TAG_OPEN, '')
    .replaceAll(CONTEXT_TAG_CLOSE, '');
  const wrappedContent = `${CONTEXT_TAG_OPEN}\n${safeContent}\n${CONTEXT_TAG_CLOSE}`;

  if (existsSync(filePath)) {
    let existingContent = readFileSync(filePath, 'utf-8');

    const openingTag = /<claude-mem-context\b[^>]*>/.exec(existingContent);
    const tagStartIndex = openingTag?.index ?? -1;
    const tagEndIndex = findContextBlockEnd(existingContent, tagStartIndex);

    if (tagStartIndex !== -1 && tagEndIndex !== -1) {
      existingContent =
        existingContent.slice(0, tagStartIndex) +
        wrappedContent +
        existingContent.slice(tagEndIndex);
    } else {
      existingContent = existingContent.trimEnd() + '\n\n' + wrappedContent + '\n';
    }

    writeFileSync(filePath, existingContent, 'utf-8');
  } else {
    if (headerLine) {
      writeFileSync(filePath, `${headerLine}\n\n${wrappedContent}\n`, 'utf-8');
    } else {
      writeFileSync(filePath, wrappedContent + '\n', 'utf-8');
    }
  }
}
