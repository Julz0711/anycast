/** Demo mode: dev builds only (or a build with VITE_DEMO=1). Activated by VITE_DEMO=1 or ?demo=1 (sticky per tab). */
let cached: boolean | null = null;
export function isDemo(): boolean {
  if (!__DEMO_ALLOWED__) return false;
  if (cached !== null) return cached;
  let on = import.meta.env.VITE_DEMO === '1';
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('demo') === '1') sessionStorage.setItem('anycast.demo', '1');
    if (q.get('demo') === '0') sessionStorage.removeItem('anycast.demo');
    on = on || sessionStorage.getItem('anycast.demo') === '1';
  } catch {
    /* storage blocked */
  }
  cached = on;
  return on;
}
