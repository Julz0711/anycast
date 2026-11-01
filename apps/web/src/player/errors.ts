/** Turn failures into honest, actionable messages. */
import type { GapCause, Pipeline } from '@anycast/shared';
import { ApiError } from '../api/client';
import { gapText } from '../lib/time';
import { PlaybackFailure } from './engine';

export type ErrAction = 'retry' | 'live' | 'back' | 'zap';
export interface PlayerErr {
  title: string;
  detail: string;
  tips: string[];
  actions: ErrAction[];
}

export function fromApiError(e: unknown, ctx: { live: boolean; timeshift: boolean }): PlayerErr {
  if (e instanceof ApiError) {
    if (e.status === 0)
      return { title: "Can't reach your AnyCast server", detail: e.message, tips: ['Check that the server is running.', 'Check your Wi-Fi or mobile data.'], actions: ['retry', 'back'] };
    if (e.status === 404)
      return {
        title: ctx.live ? "This channel isn't available" : "This title isn't available",
        detail: 'Your provider may have removed it since the last sync.',
        tips: ['Run Sync now in Settings › Source & account.'],
        actions: ctx.live ? ['zap', 'back'] : ['back'],
      };
    if (ctx.timeshift && (e.status === 400 || e.status === 416 || e.status === 422)) {
      const cause = (e.body as { cause?: GapCause } | undefined)?.cause;
      return { title: "That time isn't available", detail: cause ? gapText({ reason: e.message, cause }) : e.message, tips: ['Pick a time inside the light part of the timeline.'], actions: ['live', 'back'] };
    }
    if (e.status === 429 || /connection/i.test(e.message))
      return {
        title: 'Too many streams at once',
        detail: e.message,
        tips: ['Your provider limits how many streams can play at the same time.', 'Stop playback on another device, then try again.'],
        actions: ['retry', 'back'],
      };
    return {
      title: "The server couldn't start this stream",
      detail: e.message,
      tips: ['The provider may be down or slow right now. Try again in a minute.', ctx.live ? 'Try another channel to see if it is just this one.' : 'Check Settings › Source & account.'],
      actions: ctx.live ? ['retry', 'zap', 'back'] : ['retry', 'back'],
    };
  }
  return { title: 'Something went wrong', detail: String((e as Error)?.message ?? e), tips: [], actions: ['retry', 'back'] };
}

export function fromPlaybackFailure(f: PlaybackFailure | MediaError, pipeline: Pipeline | undefined, live: boolean): PlayerErr {
  const via = pipeline ? ` (server pipeline: ${pipeline})` : '';
  const kind = f instanceof PlaybackFailure ? f.kind : f.code === MediaError.MEDIA_ERR_NETWORK ? 'network' : f.code === MediaError.MEDIA_ERR_DECODE ? 'decode' : 'unsupported';
  const detail = f instanceof PlaybackFailure ? f.message : f.message || `Media error ${f.code}`;
  switch (kind) {
    case 'network':
      return { title: 'The stream stopped loading', detail, tips: ['Your connection or the provider dropped out.', 'Try again; if it keeps happening, try another channel.'], actions: live ? ['retry', 'zap', 'back'] : ['retry', 'back'] };
    case 'server':
      return {
        title: "The server couldn't deliver this stream",
        detail: `${detail}${f instanceof PlaybackFailure && f.status ? ` (HTTP ${f.status})` : ''}`,
        tips: ['The provider may be refusing the stream, or the connection limit is reached.', 'Stop playback on other devices and try again.'],
        actions: live ? ['retry', 'zap', 'back'] : ['retry', 'back'],
      };
    case 'decode':
      return {
        title: "This device couldn't decode the video",
        detail: detail + via,
        tips: ['The stream may use a codec this browser does not support (for example HEVC or AC-3).', 'The server can convert it: check transcoding on the server, or try another device.'],
        actions: ['retry', 'back'],
      };
    default:
      return {
        title: "This browser can't play this stream",
        detail: detail + via,
        tips: ['Try Chrome, Edge or Safari, or the app on another device.', 'The server can remux or transcode streams this browser cannot play.'],
        actions: ['retry', 'back'],
      };
  }
}
