/**
 * Central credential redaction. Anything that could identify the provider account
 * (username, password, host) is replaced, in raw and URL-encoded form, and any URL is collapsed.
 */
export interface RedactSecrets {
  username?: string | null;
  password?: string | null;
  /** provider base URL or host */
  url?: string | null;
}

const URL_RE = /\b(?:https?|rtmp|rtsp|udp|tcp):\/\/[^\s"'<>)]+/gi;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hostOf(url: string): string | null {
  try {
    return new URL(url.includes('://') ? url : `http://${url}`).hostname || null;
  } catch {
    return null;
  }
}

export type Redactor = (text: string) => string;

/** `collapseUrls` (default) replaces every URL with <url>; logs keep non-provider URLs readable. */
export function createRedactor(secrets: RedactSecrets, { collapseUrls = true } = {}): Redactor {
  const needles = new Set<string>();
  const add = (v: string | null | undefined, min: number) => {
    if (!v || v.length < min) return;
    needles.add(v);
    needles.add(encodeURIComponent(v));
  };
  add(secrets.username, 3);
  add(secrets.password, 3);
  if (secrets.url) {
    const host = hostOf(secrets.url);
    add(host, 3);
    if (host && /^[\d.]+$/.test(host) === false) {
      // registrable part, e.g. "example.com" for "line.example.com"
      add(host.split('.').slice(-2).join('.'), 6);
    }
  }
  const patterns = [...needles].sort((a, b) => b.length - a.length).map(escapeRe);
  const secretRe = patterns.length ? new RegExp(patterns.join('|'), 'gi') : null;
  return (text: string) => {
    let out = collapseUrls ? text.replace(URL_RE, '<url>') : text;
    if (secretRe) out = out.replace(secretRe, '***');
    return out.replace(/\b(username|password)=[^&\s"']+/gi, '$1=***');
  };
}

/** Applies a redactor to every string inside a JSON-like value. */
export function redactDeep<T>(value: T, redact: Redactor, depth = 0): T {
  if (typeof value === 'string') return redact(value) as T;
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    const err = new Error(redact(value.message));
    err.name = value.name;
    if (value.stack) err.stack = redact(value.stack);
    return err as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact, depth + 1)) as T;
  // leave class instances (requests, responses) to their log serializers
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact, depth + 1);
  return out as T;
}
