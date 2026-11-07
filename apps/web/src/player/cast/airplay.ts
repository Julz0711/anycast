/**
 * AirPlay (Safari on iPhone, iPad and Mac). Safari hands the <video> to an Apple TV or AirPlay TV;
 * that needs Apple's own HLS player (not MSE), so on Safari with AirPlay the app asks the server
 * for HLS (caps.ts). While AirPlay is on, the player plays a cast link (see server cast.ts), as
 * the TV fetches the stream itself and has no session cookie.
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';

type AirPlayVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

/** This browser has AirPlay for web video (Safari). */
export const airPlayApi = (w: object = typeof window === 'undefined' ? {} : window) => 'WebKitPlaybackTargetAvailabilityEvent' in w;

export function useAirPlay(videoRef: RefObject<HTMLVideoElement>) {
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const v = videoRef.current as AirPlayVideo | null;
    if (!v || !airPlayApi()) return;
    const onAvail = (e: Event) => setAvailable((e as Event & { availability?: string }).availability === 'available');
    const onWireless = () => setActive(!!v.webkitCurrentPlaybackTargetIsWireless);
    v.addEventListener('webkitplaybacktargetavailabilitychanged', onAvail);
    v.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
    onWireless();
    return () => {
      v.removeEventListener('webkitplaybacktargetavailabilitychanged', onAvail);
      v.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
    };
  }, [videoRef]);
  const prompt = useCallback(() => (videoRef.current as AirPlayVideo | null)?.webkitShowPlaybackTargetPicker?.(), [videoRef]);
  return { available, active, prompt };
}

export type AirPlayControl = ReturnType<typeof useAirPlay>;
