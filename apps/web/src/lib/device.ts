export type FormFactor = 'phone' | 'large' | 'tv';
export type DeviceOverride = 'auto' | 'phone' | 'desktop' | 'tv';

const TV_UA = /Android ?TV|GoogleTV|Tizen|Web0S|webOS|BRAVIA|\bAFT[A-Z0-9]|SMART-TV|SmartTV|HbbTV|CrKey|Roku/i;

export function isTvUserAgent(ua: string): boolean {
  return TV_UA.test(ua);
}

/** Width below which we use the phone layout (bottom tab bar). */
export const PHONE_MAX_WIDTH = 760;
/**
 * A touch-only screen whose short side is below this is a phone, also when it is turned sideways
 * (an iPhone in landscape is 844-932 px wide but only ~390-430 px tall). Tablets are 744 px and up.
 */
export const PHONE_MAX_SHORT_SIDE = 520;

export function detectFormFactor(env: {
  ua: string;
  search: string;
  width: number;
  override: DeviceOverride;
  /** the device screen's short side in CSS px (stable: no change when the keyboard opens or the phone turns) */
  screenShort?: number;
  /** touch is the only pointer (no mouse, no hover) */
  touch?: boolean;
}): FormFactor {
  if (env.override === 'tv') return 'tv';
  if (env.override === 'phone') return 'phone';
  if (env.override === 'desktop') return 'large';
  const q = new URLSearchParams(env.search);
  if (q.get('tv') === '1' || isTvUserAgent(env.ua)) return 'tv';
  if (env.width < PHONE_MAX_WIDTH) return 'phone';
  if (env.touch && env.screenShort !== undefined && env.screenShort < PHONE_MAX_SHORT_SIDE) return 'phone';
  return 'large';
}
