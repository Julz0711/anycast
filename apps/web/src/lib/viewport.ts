/**
 * Phones: follow the on-screen keyboard. iOS Safari and installed PWAs keep the layout viewport
 * full height while the keyboard is up, so fixed bars and bottom sheets would sit behind it.
 * This publishes the covered height as `--kb` on <html> and sets `data-kb="open"`, which the
 * phone styles use to lift sheets above the keyboard and hide the tab bar while typing.
 */
export function keyboardInset(layoutHeight: number, visualHeight: number, visualTop: number): number {
  const covered = Math.round(layoutHeight - visualHeight - visualTop);
  // smaller changes are browser chrome (the URL bar collapsing), not a keyboard
  return covered > 120 ? covered : 0;
}

export function watchKeyboard(root: HTMLElement = document.documentElement): () => void {
  const vv = window.visualViewport;
  // only touch screens have an on-screen keyboard; desktops and TVs are left alone
  if (!vv || !matchMedia('(pointer: coarse)').matches) return () => {};
  let last = -1;
  const update = () => {
    const kb = keyboardInset(window.innerHeight, vv.height, vv.offsetTop);
    if (kb === last) return;
    last = kb;
    root.style.setProperty('--kb', `${kb}px`);
    if (kb) root.dataset.kb = 'open';
    else delete root.dataset.kb;
  };
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
  };
}
