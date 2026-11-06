/** Warm the player route chunk on hover/focus so opening a channel feels instant. */
let warmed = false;
export function prefetchPlayer() {
  if (warmed) return;
  warmed = true;
  void import('./PlayerScreen');
}
