import { describe, expect, it } from 'bun:test';
import { getDoctorExitCode } from '../src/npx-cli/commands/doctor.js';

describe('npx claude-mem doctor exit contract', () => {
  it('returns 0 when required checks pass and the worker is healthy', () => {
    expect(getDoctorExitCode(0, 'ok')).toBe(0);
  });

  it('returns 1 when the worker is reachable but unhealthy', () => {
    expect(getDoctorExitCode(0, 'warn')).toBe(1);
  });

  it('returns 2 when required checks pass but the worker is unreachable', () => {
    expect(getDoctorExitCode(0, 'fail')).toBe(2);
  });

  it('prioritizes required install failures over worker reachability', () => {
    expect(getDoctorExitCode(1, 'fail')).toBe(1);
  });
});