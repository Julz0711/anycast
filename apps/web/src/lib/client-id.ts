/**
 * Identity of this app instance for playback (x-anycast-client / x-anycast-device). One id per tab
 * (sessionStorage), kept across reloads, so the server can release this tab's previous stream when
 * it asks for the next one and can tell other devices who is watching.
 */
const KEY = 'anycast.clientId';

function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'c-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let cached: string | null = null;
export function clientId(): string {
  if (cached) return cached;
  try {
    cached = sessionStorage.getItem(KEY);
    if (!cached) {
      cached = newId();
      sessionStorage.setItem(KEY, cached);
    }
  } catch {
    cached ??= newId();
  }
  return cached;
}

/** "Chrome on Mac", "Safari on iPhone", "TV" — shown to other devices ("… is watching on Chrome on Mac"). */
export function deviceLabel(ua: string = navigator.userAgent): string {
  if (/Android ?TV|GoogleTV|Tizen|Web0S|webOS|BRAVIA|\bAFT[A-Z0-9]|SMART-TV|SmartTV|HbbTV|CrKey|Roku/i.test(ua)) return 'TV';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'Chromebook'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Browser';
}
