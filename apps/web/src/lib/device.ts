export type FormFactor = 'phone' | 'large' | 'tv';
export type DeviceOverride = 'auto' | 'phone' | 'desktop' | 'tv';

const TV_UA = /Android ?TV|GoogleTV|Tizen|Web0S|webOS|BRAVIA|\bAFT[A-Z0-9]|SMART-TV|SmartTV|HbbTV|CrKey|Roku/i;

export function isTvUserAgent(ua: string): boolean {
  return TV_UA.test(ua);
}

/** Width below which we use the phone layout (bottom tab bar). */
export const PHONE_MAX_WIDTH = 760;

export function detectFormFactor(env: { ua: string; search: string; width: number; override: DeviceOverride }): FormFactor {
  if (env.override === 'tv') return 'tv';
  if (env.override === 'phone') return 'phone';
  if (env.override === 'desktop') return 'large';
  const q = new URLSearchParams(env.search);
  if (q.get('tv') === '1' || isTvUserAgent(env.ua)) return 'tv';
  return env.width < PHONE_MAX_WIDTH ? 'phone' : 'large';
}
