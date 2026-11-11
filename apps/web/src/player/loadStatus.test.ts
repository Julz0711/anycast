import { describe, expect, it } from 'vitest';
import { failureReason } from './engine';
import { elapsedText, loadStepText } from './loadStatus';

describe('load status', () => {
  it('says what the player waits on', () => {
    expect(loadStepText({ stage: 'connecting' })).toBe('Connecting to your server…');
    expect(loadStepText({ stage: 'preparing', pipeline: 'transcode' })).toContain('converting');
    expect(loadStepText({ stage: 'preparing', pipeline: 'remux' })).toBe('Your server is starting the video…');
    expect(loadStepText({ stage: 'retrying', attempt: 2, status: 502 })).toBe('Your server answered with an error (HTTP 502). Trying again (2)…');
    expect(loadStepText({ stage: 'retrying', attempt: 1 })).toContain('No answer');
  });
  it('formats the time so far', () => {
    expect(elapsedText(8_400)).toBe('8 s');
    expect(elapsedText(65_000)).toBe('1:05');
  });
});

describe('failureReason', () => {
  const answer = (status: number, body: string, type: string) => (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;
  it("uses the server's own reason", async () => {
    const why = await failureReason('/x', 502, answer(502, JSON.stringify({ error: 'stream', message: 'The provider refused the stream (HTTP 403).' }), 'application/json'));
    expect(why).toBe('The provider refused the stream (HTTP 403).');
  });
  it('blames the reverse proxy for its own error page', async () => {
    expect(await failureReason('/x', 502, answer(502, '<html>502 Bad Gateway</html>', 'text/html'))).toMatch(/reverse proxy/);
  });
  it('has nothing to say when the file loads now', async () => {
    expect(await failureReason('/x', 502, answer(200, 'ok', 'video/mp4'))).toBeNull();
  });
});
