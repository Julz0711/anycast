/**
 * Picture-in-picture (PB-4): the standard API (document.pictureInPictureEnabled) or Safari's
 * presentation mode (webkitSetPresentationMode). The button is not rendered where neither exists;
 * the player's `P` shortcut toggles it where it is.
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';
import { IconPip } from './ExtrasIcons';

type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture' | 'fullscreen') => void;
  webkitPresentationMode?: string;
};

export type PipKind = 'standard' | 'webkit';

export function pipSupport(video: HTMLVideoElement | null, doc: Pick<Document, 'pictureInPictureEnabled'> = document): PipKind | null {
  if (!video) return null;
  if (doc.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function' && !video.disablePictureInPicture) return 'standard';
  const w = video as WebkitVideo;
  if (typeof w.webkitSupportsPresentationMode === 'function' && typeof w.webkitSetPresentationMode === 'function' && w.webkitSupportsPresentationMode('picture-in-picture')) return 'webkit';
  return null;
}

function isInPip(video: HTMLVideoElement): boolean {
  return document.pictureInPictureElement === video || (video as WebkitVideo).webkitPresentationMode === 'picture-in-picture';
}

export function usePictureInPicture(videoRef: RefObject<HTMLVideoElement>) {
  const [kind, setKind] = useState<PipKind | null>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const v = videoRef.current;
    setKind(pipSupport(v));
    if (!v) return;
    const sync = () => setActive(isInPip(v));
    v.addEventListener('enterpictureinpicture', sync);
    v.addEventListener('leavepictureinpicture', sync);
    v.addEventListener('webkitpresentationmodechanged', sync);
    return () => {
      v.removeEventListener('enterpictureinpicture', sync);
      v.removeEventListener('leavepictureinpicture', sync);
      v.removeEventListener('webkitpresentationmodechanged', sync);
    };
  }, [videoRef]);

  const toggle = useCallback(async () => {
    const v = videoRef.current as WebkitVideo | null;
    if (!v || !kind) return;
    try {
      if (kind === 'webkit') v.webkitSetPresentationMode!(isInPip(v) ? 'inline' : 'picture-in-picture');
      else if (document.pictureInPictureElement === v) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* refused (no metadata yet, or no user gesture): nothing to undo */
    }
  }, [videoRef, kind]);

  return { supported: kind !== null, active, toggle };
}

export type PipControl = ReturnType<typeof usePictureInPicture>;

/** The button (rendered only where picture in picture is supported); `P` toggles it too (PlayerScreen). */
export function PipButton({ pip, className = 'btn' }: { pip: PipControl; className?: string }) {
  if (!pip.supported) return null;
  return (
    <button
      type="button"
      className={`${className}${pip.active ? ' on' : ''}`}
      aria-pressed={pip.active}
      aria-label={pip.active ? 'Exit picture in picture' : 'Picture in picture'}
      aria-keyshortcuts="P"
      title="Picture in picture (P)"
      onClick={() => void pip.toggle()}
    >
      <IconPip />
    </button>
  );
}
