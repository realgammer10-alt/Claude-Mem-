
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

const mockGetObservationsByFilePath = mock(() => [{ id: 3 }]);

mock.module('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => '/tmp/test',
}));
mock.module('../../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));
mock.module('../../../../src/services/sqlite/observations/get.js', () => ({
  getObservationsByFilePath: mockGetObservationsByFilePath,
}));

import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createMockReqRes(body: any): { req: Partial<Request>; res: Partial<Response>; jsonSpy: ReturnType<typeof mock>; statusSpy: ReturnType<typeof mock> } {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/test', query: {} } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function captureChain(mockApp: any, targetPath: string): (req: Request, res: Response) => void {
  let middleware: (req: Request, res: Response, next: () => void) => void;
  let handler: (req: Request, res: Response) => void;
  mockApp.post = mock((path: string, ...rest: any[]) => {
    if (path !== targetPath) return;
    if (rest.length === 1) {
      handler = rest[0];
    } else {
      middleware = rest[0];
      handler = rest[1];
    }
  });
  return (req: Request, res: Response): void => {
    if (!middleware) {
      handler(req, res);
      return;
    }
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    if (nextCalled) handler(req, res);
  };
}

describe('DataRoutes Type Coercion', () => {
  let routes: DataRoutes;
  let mockGetObservationsByIds: ReturnType<typeof mock>;
  let mockGetObservations: ReturnType<typeof mock>;
  let mockGetObservationById: ReturnType<typeof mock>;
  let mockGetAllProjects: ReturnType<typeof mock>;
  let mockGetSdkSessionsBySessionIds: ReturnType<typeof mock>;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    mockGetObservationsByIds = mock(() => [{ id: 1 }, { id: 2 }]);
    mockGetObservations = mock(() => ({ items: [], hasMore: false }));
    mockGetObservationById = mock(() => ({ id: 12 }));
    mockGetAllProjects = mock(() => ['project']);
    mockGetSdkSessionsBySessionIds = mock(() => [{ id: 'abc' }]);

    const mockDbManager = {
      getSessionStore: () => ({
        getObservationsByIds: mockGetObservationsByIds,
          getObservationById: mockGetObservationById,
          getAllProjects: mockGetAllProjects,
        getSdkSessionsBySessionIds: mockGetSdkSessionsBySessionIds,
          db: {},
      }),
    };

    routes = new DataRoutes(
      { getObservations: mockGetObservations } as any, // paginationHelper
      mockDbManager as any,
      {} as any, // sessionManager
      {} as any, // sseBroadcaster
      {} as any, // workerService
      Date.now()
    );
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  describe('handleGetObservationsByIds — ids coercion', () => {
    let handler: (req: Request, res: Response) => void;

    beforeEach(() => {
      const mockApp: any = {
        get: mock(() => {}),
        delete: mock(() => {}),
        use: mock(() => {}),
      };
      handler = captureChain(mockApp, '/api/observations/batch');
      routes.setupRoutes(mockApp as any);
    });

    it('should accept a native array of numbers', () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: [1, 2, 3] });
      handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith([1, 2, 3], expect.anything());
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('forwards and normalizes platformSource for batch detail reads', () => {
      const { req, res } = createMockReqRes({
        ids: [1, 2],
        platformSource: 'codex-cli',
      });
      handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith(
        [1, 2],
        expect.objectContaining({ platformSource: 'codex' }),
      );
    });

    it('should coerce a JSON-encoded string array "[1,2,3]" to native array', () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: '[1,2,3]' });
      handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith([1, 2, 3], expect.anything());
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should coerce a comma-separated string "1,2,3" to native array', () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: '1,2,3' });
      handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith([1, 2, 3], expect.anything());
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should reject non-integer values after coercion', () => {
      const { req, res, statusSpy } = createMockReqRes({ ids: 'foo,bar' });
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should reject missing ids', () => {
      const { req, res, statusSpy } = createMockReqRes({});
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should return empty array for empty ids array', () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: [] });
      handler(req as Request, res as Response);

      expect(jsonSpy).toHaveBeenCalledWith([]);
    });
  });

  describe('handleGetSdkSessionsByIds — memorySessionIds coercion', () => {
    let handler: (req: Request, res: Response) => void;

    beforeEach(() => {
      const mockApp: any = {
        get: mock(() => {}),
        delete: mock(() => {}),
        use: mock(() => {}),
      };
      handler = captureChain(mockApp, '/api/sdk-sessions/batch');
      routes.setupRoutes(mockApp as any);
    });

    it('should accept a native array of strings', () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: ['abc', 'def'] });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should coerce a JSON-encoded string array to native array', () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: '["abc","def"]' });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should coerce a comma-separated string to native array', () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: 'abc,def' });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should trim whitespace from comma-separated values', () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: 'abc, def , ghi' });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def', 'ghi']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should reject whitespace-only array entries', () => {
      const { req, res, statusSpy } = createMockReqRes({ memorySessionIds: ['abc', '   '] });
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should accept legacy sdkSessionIds as a compatibility alias', () => {
      const { req, res, jsonSpy } = createMockReqRes({ sdkSessionIds: ['abc', 'def'] });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should prefer canonical memorySessionIds when both fields are provided', () => {
      const { req, res, jsonSpy } = createMockReqRes({
        memorySessionIds: ['canonical'],
        sdkSessionIds: ['legacy'],
      });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['canonical']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should reject non-array, non-string values', () => {
      const { req, res, statusSpy } = createMockReqRes({ memorySessionIds: 42 });
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('forwards normalized platformSource for SDK session batch reads', () => {
      const { req, res } = createMockReqRes({
        memorySessionIds: ['abc', 'def'],
        platformSource: 'codex-cli',
      });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(
        ['abc', 'def'],
        'codex',
      );
    });
  });

  describe('handleGetObservationsByFile — query coercion', () => {
    let handler: (req: Request, res: Response) => void;

    beforeEach(() => {
      const mockApp: any = {
        get: mock((path: string, routeHandler: (req: Request, res: Response) => void) => {
          if (path === '/api/observations/by-file') handler = routeHandler;
        }),
        post: mock(() => {}),
        delete: mock(() => {}),
        use: mock(() => {}),
      };
      routes.setupRoutes(mockApp as any);
    });

    it('accepts repeated projects query parameters', () => {
      const { res, jsonSpy } = createMockReqRes(undefined);
      const req = {
        path: '/api/observations/by-file',
        query: { path: 'src/parser.ts', projects: ['alpha', 'beta'] },
      } as unknown as Request;

      handler(req, res as Response);

      expect(mockGetObservationsByFilePath).toHaveBeenCalledWith(
        {},
        ['src/parser.ts'],
        { projects: ['alpha', 'beta'], limit: undefined },
      );
      expect(jsonSpy).toHaveBeenCalledWith({ observations: [{ id: 3 }], count: 1 });
    });

    it('forwards normalized platformSource for file reads', () => {
      const { res } = createMockReqRes(undefined);
      const req = {
        path: '/api/observations/by-file',
        query: { path: 'src/parser.ts', platformSource: 'codex-cli' },
      } as unknown as Request;

      handler(req, res as Response);

      expect(mockGetObservationsByFilePath).toHaveBeenCalledWith(
        {},
        ['src/parser.ts'],
        { projects: undefined, platformSource: 'codex', limit: undefined },
      );
    });
  });

  describe('handleGetObservationById — id coercion', () => {
    let handler: (req: Request, res: Response) => void;

    beforeEach(() => {
      const mockApp: any = {
        get: mock((path: string, routeHandler: (req: Request, res: Response) => void) => {
          if (path === '/api/observation/:id') handler = routeHandler;
        }),
        post: mock(() => {}),
        delete: mock(() => {}),
        use: mock(() => {}),
      };
      routes.setupRoutes(mockApp as any);
    });

    it('rejects partially numeric IDs instead of truncating them', () => {
      const { res, statusSpy } = createMockReqRes(undefined);
      const req = {
        path: '/api/observation/12junk',
        params: { id: '12junk' },
        query: {},
      } as unknown as Request;

      handler(req, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(mockGetObservationById).not.toHaveBeenCalled();
    });

    it('forwards normalized platformSource to individual observation reads', () => {
      const { res } = createMockReqRes(undefined);
      const req = {
        path: '/api/observation/12',
        params: { id: '12' },
        query: { platformSource: 'codex-cli' },
      } as unknown as Request;

      handler(req, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith(
        [12],
        expect.objectContaining({ platformSource: 'codex' }),
      );
    });
  });

  describe('handleGetProjects — platformSource coercion', () => {
    let handler: (req: Request, res: Response) => void;

    beforeEach(() => {
      const mockApp: any = {
        get: mock((path: string, routeHandler: (req: Request, res: Response) => void) => {
          if (path === '/api/projects') handler = routeHandler;
        }),
        post: mock(() => {}),
        delete: mock(() => {}),
        use: mock(() => {}),
      };
      routes.setupRoutes(mockApp as any);
    });

    it('rejects repeated platformSource query parameters', () => {
      const { res, statusSpy } = createMockReqRes(undefined);
      const req = {
        path: '/api/projects',
        query: { platformSource: ['claude', 'cursor'] },
      } as unknown as Request;

      handler(req, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(mockGetAllProjects).not.toHaveBeenCalled();
    });
  });

  describe('handleGetObservations — pagination coercion', () => {
    let handler: (req: Request, res: Response) => void;

    beforeEach(() => {
      const mockApp: any = {
        get: mock((path: string, routeHandler: (req: Request, res: Response) => void) => {
          if (path === '/api/observations') handler = routeHandler;
        }),
        post: mock(() => {}),
        delete: mock(() => {}),
        use: mock(() => {}),
      };
      routes.setupRoutes(mockApp as any);
    });

    it('falls back for negative offset and limit values', () => {
      const { res, jsonSpy } = createMockReqRes(undefined);
      const req = {
        path: '/api/observations',
        query: { offset: '-4', limit: '-1' },
      } as unknown as Request;

      handler(req, res as Response);

      expect(mockGetObservations).toHaveBeenCalledWith(0, 20, undefined, undefined);
      expect(jsonSpy).toHaveBeenCalledWith({ items: [], hasMore: false });
    });

    it('falls back for partially numeric offset and limit values', () => {
      const { res } = createMockReqRes(undefined);
      const req = {
        path: '/api/observations',
        query: { offset: '12junk', limit: '5items' },
      } as unknown as Request;

      handler(req, res as Response);

      expect(mockGetObservations).toHaveBeenCalledWith(0, 20, undefined, undefined);
    });

    it('ignores repeated platformSource values without throwing', () => {
      const { res } = createMockReqRes(undefined);
      const req = {
        path: '/api/observations',
        query: { platformSource: ['codex-cli', 'cursor'] },
      } as unknown as Request;

      expect(() => handler(req, res as Response)).not.toThrow();
      expect(mockGetObservations).toHaveBeenCalledWith(0, 20, undefined, undefined);
    });
  });
});
