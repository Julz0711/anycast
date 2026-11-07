import { normalizeTabOrder, type TabId } from '@anycast/shared';
import { IconHome, IconLibrary, IconLive, IconMovie, IconSearch, IconSeries, IconSettings } from '../components/Icons';

export const TABS: Record<TabId | 'settings', { label: string; short: string; path: string; key: string; Icon: typeof IconLive }> = {
  home: { label: 'Home', short: 'Home', path: '/home', key: 'H', Icon: IconHome },
  search: { label: 'Search', short: 'Search', path: '/search', key: '/', Icon: IconSearch },
  live: { label: 'Live TV', short: 'Live', path: '/live', key: 'L', Icon: IconLive },
  movies: { label: 'Movies', short: 'Movies', path: '/movies', key: 'M', Icon: IconMovie },
  series: { label: 'Series', short: 'Series', path: '/series', key: 'S', Icon: IconSeries },
  library: { label: 'Library', short: 'Library', path: '/library', key: 'B', Icon: IconLibrary },
  settings: { label: 'Settings', short: 'Settings', path: '/settings', key: ',', Icon: IconSettings },
};

export function visibleTabs(order: TabId[], hidden: TabId[]): TabId[] {
  const vis = normalizeTabOrder(order).filter((t) => !hidden.includes(t));
  return vis.length ? vis : ['live'];
}

/** Library holds Favorites and Lists: its tab is current on their pages too. */
export const tabMatches = (id: TabId | 'settings', pathname: string) =>
  id === 'library' ? /^\/(library|favorites|lists)(\/|$)/.test(pathname) : pathname === TABS[id].path || pathname.startsWith(`${TABS[id].path}/`);
