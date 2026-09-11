import { describe, expect, it } from 'bun:test';
import { parseServerExportArgs, ServerExportArgsError } from '../../src/server/export-args.js';

describe('parseServerExportArgs', () => {
  it('parses separated and equals-form options', () => {
    expect(parseServerExportArgs(['--project-id', 'project-1', '--include-audit', '--limit=25'])).toEqual({
      projectId: 'project-1',
      includeAudit: true,
      limit: 25,
    });
  });

  it('rejects missing, malformed, duplicate, and unknown arguments', () => {
    const invalid = [
      ['--project-id'],
      ['--project-id', '   '],
      ['--project-id', ' project-1 '],
      ['--limit'],
      ['--include-audit=true'],
      ['--limit', '10junk'],
      ['--limit', '0'],
      ['--limit', '10001'],
      ['--limit', '1.5'],
      ['--limit', '1', '--limit', '2'],
      ['--include-audit', '--include-audit'],
      ['--unknown'],
      ['stray-value'],
    ];

    for (const args of invalid) {
      expect(() => parseServerExportArgs(args)).toThrow(ServerExportArgsError);
    }
  });
});