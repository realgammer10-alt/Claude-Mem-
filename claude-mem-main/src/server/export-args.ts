export interface ServerExportArgs {
  projectId?: string;
  includeAudit?: boolean;
  limit?: number;
}

export class ServerExportArgsError extends Error {
  constructor() {
    super('Invalid server export arguments');
    this.name = 'ServerExportArgsError';
  }
}

export function parseServerExportArgs(argv: readonly string[]): ServerExportArgs {
  const consumed = new Set<number>();
  let projectId: string | undefined;
  let includeAudit = false;
  let limit: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    if (consumed.has(index)) continue;
    const arg = argv[index]!;

    if (arg === '--project-id' || arg.startsWith('--project-id=')) {
      if (projectId !== undefined) throw new ServerExportArgsError();
      const value = arg === '--project-id' ? argv[index + 1] : arg.slice('--project-id='.length);
      if (!value || value.trim() !== value || value.startsWith('--')) throw new ServerExportArgsError();
      if (arg === '--project-id') consumed.add(index + 1);
      projectId = value;
      continue;
    }

    if (arg === '--limit' || arg.startsWith('--limit=')) {
      if (limit !== undefined) throw new ServerExportArgsError();
      const value = arg === '--limit' ? argv[index + 1] : arg.slice('--limit='.length);
      if (!value || value.startsWith('--') || !/^\d+$/.test(value)) {
        throw new ServerExportArgsError();
      }
      if (arg === '--limit') consumed.add(index + 1);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
        throw new ServerExportArgsError();
      }
      limit = parsed;
      continue;
    }

    if (arg === '--include-audit') {
      if (includeAudit) throw new ServerExportArgsError();
      includeAudit = true;
      continue;
    }

    throw new ServerExportArgsError();
  }

  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(includeAudit ? { includeAudit: true } : {}),
    ...(limit === undefined ? {} : { limit }),
  };
}