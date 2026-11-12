import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/global.css';
import './theme/mobile.css';
import './theme/signal.css';
import { App } from './App';
import { configureClient } from './api/client';
import { capsHeader, withLiveStream } from './player/caps';
import { useApp } from './store/app';
import { bootstrap, clearProfile, onUnauthorized } from './store/actions';
import { requireUnlock } from './store/parental';
import { watchKeyboard } from './lib/viewport';

configureClient({
  profileId: () => useApp.getState().profileId,
  caps: () => withLiveStream(capsHeader(), useApp.getState().prefs.player.liveStream),
  onUnauthorized,
  onProfileInvalid: clearProfile,
  onAdultLocked: () => requireUnlock({ force: true }),
});

void bootstrap();
watchKeyboard();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
