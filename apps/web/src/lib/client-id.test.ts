import { describe, expect, test } from 'vitest';
import { deviceLabel } from './client-id';

describe('deviceLabel', () => {
  test('names browser and system', () => {
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome on Mac');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge on Windows');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit/537.36 Chrome/120 Safari/537.36')).toBe('TV');
    expect(deviceLabel('curl/8')).toBe('Browser');
  });
});
