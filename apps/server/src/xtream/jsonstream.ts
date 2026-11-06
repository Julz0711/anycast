/**
 * Streams the elements of a big JSON list (a panel's get_vod_streams can be 100+ MB) without
 * holding the whole document: yields each element of a top-level array, or each value of a
 * top-level object (some panels key their lists by id), parsed one at a time. Memory stays bounded
 * by the largest single element. A top-level `null`, an empty body or any other scalar yields nothing.
 */
import { XtreamError } from './client';

const QUOTE = 34;
const BACKSLASH = 92;
const COMMA = 44;
const OPEN_ARR = 91;
const CLOSE_ARR = 93;
const OPEN_OBJ = 123;
const CLOSE_OBJ = 125;

const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;

export async function* jsonListItems(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder('utf-8');
  /** top level: 0 = not seen yet, OPEN_ARR / OPEN_OBJ, -1 = scalar (ignored) */
  let top = 0;
  let depth = 0;
  let inString = false;
  let escape = false;
  /** text of the current element (object top level: "key": value) */
  let cur = '';
  let done = false;

  const parse = (text: string): unknown => {
    try {
      if (top === OPEN_OBJ) return Object.values(JSON.parse(`{${text}}`) as Record<string, unknown>)[0];
      return JSON.parse(text);
    } catch {
      throw new XtreamError('Provider returned a response that is not JSON', 'parse');
    }
  };

  for await (const chunk of stream) {
    if (done) continue;
    const s = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let from = 0;
    const out: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (inString) {
        if (escape) escape = false;
        else if (c === BACKSLASH) escape = true;
        else if (c === QUOTE) inString = false;
        continue;
      }
      if (top === 0) {
        if (isSpace(c) || c === 0xfeff) continue;
        if (c === OPEN_ARR || c === OPEN_OBJ) {
          top = c;
          depth = 1;
          from = i + 1;
        } else {
          top = -1;
          done = true;
          break;
        }
        continue;
      }
      if (c === QUOTE) inString = true;
      else if (c === OPEN_ARR || c === OPEN_OBJ) depth++;
      else if (c === CLOSE_ARR || c === CLOSE_OBJ) {
        depth--;
        if (depth === 0) {
          // end of the list
          const text = cur + s.slice(from, i);
          cur = '';
          if (text.trim()) out.push(text);
          done = true;
          break;
        }
      } else if (c === COMMA && depth === 1) {
        out.push(cur + s.slice(from, i));
        cur = '';
        from = i + 1;
      }
    }
    if (!done) cur += s.slice(from);
    for (const text of out) {
      if (!text.trim()) continue;
      yield parse(text);
    }
  }
  if (top === OPEN_ARR || top === OPEN_OBJ) {
    if (!done) throw new XtreamError('Provider returned a response that is not JSON', 'parse');
  }
}
