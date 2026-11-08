/**
 * The provider login (Xtream Codes), managed by an admin in Settings › Provider or on the first-run
 * setup screen. The password goes to the server and is never sent back.
 */

/** What an admin sees of the saved login: never the password. */
export interface ProviderSettings {
  configured: boolean;
  /** the panel address, e.g. http://provider.example:8080 */
  url: string | null;
  username: string | null;
  /** where the saved login came from: the server's .env file or entered in the app */
  origin: 'env' | 'app' | null;
  /** the server's .env has XTREAM_URL, XTREAM_USERNAME and XTREAM_PASSWORD (changing them there wins at the next restart) */
  envSet: boolean;
  updatedAt: number | null;
}

/** A login to test or save. Without `password`, the saved password is used (only changing the address or user). */
export interface ProviderLogin {
  url: string;
  username: string;
  password?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  /** why it failed, in plain words (never contains the login) */
  message?: string;
  account?: { status: string; expiresAt: number | null; maxConnections: number | null };
}

export const PROVIDER_LIMITS = { url: 500, username: 200, password: 200 } as const;

/**
 * Turns what someone pasted into the address field into the panel address. Accepts a bare host
 * ("provider.tv:8080"), an address with a trailing slash, or a whole playlist / API link
 * ("http://host:8080/get.php?username=u&password=p&type=m3u_plus"), whose username and password
 * are returned so the form can fill them in. Returns null when it isn't a usable http(s) address.
 */
export function parseProviderUrl(input: string): { url: string; username?: string; password?: string } | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  const username = u.searchParams.get('username') ?? undefined;
  const password = u.searchParams.get('password') ?? undefined;
  // the API files of a panel; the address is the folder they live in
  const path = u.pathname.replace(/\/(get|player_api|xmltv|panel_api)\.php$/i, '').replace(/\/+$/, '');
  const url = `${u.protocol}//${u.host}${path}`;
  return { url, ...(username ? { username } : {}), ...(password ? { password } : {}) };
}
