import { describe, expect, it } from 'bun:test';
import {
  getServerDoctorExitCode,
  getWorkerDoctorExitCode,
  parseServerDoctorPort,
} from '../src/npx-cli/commands/server.js';

describe('npx claude-mem server doctor exit contract', () => {
  it('returns 0 for valid configuration and reachable server', () => {
    expect(getServerDoctorExitCode(0, 'healthy')).toBe(0);
  });

  it('returns 1 for valid configuration and unhealthy server', () => {
    expect(getServerDoctorExitCode(0, 'unhealthy')).toBe(1);
  });

  it('returns 2 for valid configuration and unreachable server', () => {
    expect(getServerDoctorExitCode(0, 'unreachable')).toBe(2);
  });

  it('prioritizes invalid configuration over server reachability', () => {
    expect(getServerDoctorExitCode(1, 'healthy')).toBe(1);
    expect(getServerDoctorExitCode(1, 'unreachable')).toBe(1);
  });
  
  it('accepts only a strict TCP port value', () => {
    expect(parseServerDoctorPort('37877', 40000)).toBe(37877);
    expect(parseServerDoctorPort(' 37877 ', 40000)).toBe(37877);
    expect(parseServerDoctorPort('37877junk', 40000)).toBe(40000);
    expect(parseServerDoctorPort('0', 40000)).toBe(40000);
    expect(parseServerDoctorPort('65536', 40000)).toBe(40000);
  });
});

describe('npx claude-mem worker doctor exit contract', () => {
  it('returns 0 for a healthy reachable worker', () => {
    expect(getWorkerDoctorExitCode('ok', true)).toBe(0);
  });

  it('returns 1 for a reachable degraded worker', () => {
    expect(getWorkerDoctorExitCode('degraded', true)).toBe(1);
  });

  it('returns 2 when the worker is unreachable', () => {
    expect(getWorkerDoctorExitCode(undefined, false)).toBe(2);
  });

  it('treats reachable malformed health as unhealthy, not unreachable', () => {
    expect(getWorkerDoctorExitCode('unhealthy', true)).toBe(1);
  });
});