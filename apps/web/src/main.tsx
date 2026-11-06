import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/global.css';
import { App } from './App';
import { configureClient } from './api/client';
import { capsHeader } from './player/caps';
import { useApp } from './store/app';
import { bootstrap, clearProfile, onUnauthorized } from './store/actions';
import { requireUnlock } from './store/parental';

configureClient({
  profileId: () => useApp.getState().profileId,
  caps: capsHeader,
  onUnauthorized,
  onProfileInvalid: clearProfile,
  onAdultLocked: () => requireUnlock({ force: true }),
});

void bootstrap();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
