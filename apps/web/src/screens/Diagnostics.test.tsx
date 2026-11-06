import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { connectionsHint, DiagnosticsSection, fmtUptime } from './Diagnostics';
import { probeSummary } from './HwEncoding';

afterEach(cleanup);

test('uptime', () => {
  expect(fmtUptime(42)).toBe('42 s');
  expect(fmtUptime(125 * 60)).toBe('2 h 5 min');
  expect(fmtUptime(3 * 86_400 + 4 * 3600 + 59)).toBe('3 d 4 h');
  expect(fmtUptime(86_400)).toBe('1 d');
});

test('connections hint', () => {
  expect(connectionsHint({})).toBe('Nothing is playing from the provider right now.');
  expect(connectionsHint({ live: 1, timeshift: 1 })).toBe('In use for: 1 live, 1 archive.');
});

test('non-admins see a one-line note instead of the server diagnostics, and nothing is fetched', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const Row = (p: { label: string; children: ReactNode }) => <div>{p.children}</div>;
  render(<DiagnosticsSection isAdmin={false} Row={Row} />);
  expect(screen.getByTestId('diagnostics-admin-only').textContent).toBe('Server diagnostics (FFmpeg, provider connections, disk use) are visible to admins.');
  expect(screen.queryByTestId('diagnostics')).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

test('hardware encoder test summary', () => {
  expect(probeSummary({ probes: [] })).toBeNull();
  expect(probeSummary({ probes: [{ method: 'nvenc', ok: false, error: 'Cannot load libcuda.so.1' }, { method: 'vaapi', ok: true, error: null }] })).toBe(
    'Tested: NVENC failed (Cannot load libcuda.so.1); VAAPI works.',
  );
});
