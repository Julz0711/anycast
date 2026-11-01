/**
 * Settings. Basic shows the essentials; All settings shows every Preferences field, grouped.
 * Every change applies immediately (optimistic) and syncs to the profile's other devices.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ACCENTS, DEFAULT_PREFERENCES, type AccentId, type HideRules, type MediaKind, type Preferences, type Profile, type TabId } from '@anycast/shared';
import { useApp } from '../store/app';
import { logout, patchPrefs, saveHideRules, selectProfile, setDeviceOverride, setPref, toast } from '../store/actions';
import { ApiError, cachedGet, call, errorMessage } from '../api/client';
import { fmtBytes, setBufferPin } from '../api/buffer';
import { useAsync, useFormFactor } from '../lib/hooks';
import { COMMON_LANGUAGES, countryName, languageName } from '../lib/lang';
import { fmtLength, fmtRelativeAgo } from '../lib/time';
import { capsHeader } from '../player/caps';
import { isDemo } from '../demo/flag';
import { TABS, visibleTabs } from '../layout/tabs';
import { ProgressBar, Segmented, Skeleton, Toggle } from '../components/ui';
import { IconDown, IconDrag, IconRefresh, IconUp } from '../components/Icons';
import type { DeviceOverride, FormFactor } from '../lib/device';
import '../theme/settings.css';

type P = Preferences;
const opts = <T extends string | number>(...pairs: [T, string][]) => pairs.map(([value, label]) => ({ value, label }));
const LAYOUT_KEY = { phone: 'layoutPhone', large: 'layoutLarge', tv: 'layoutTv' } as const;
const FORM_NAME: Record<FormFactor, string> = { phone: 'phone', large: 'desktop & tablet', tv: 'TV' };

export default function SettingsScreen() {
  const prefs = useApp((s) => s.prefs);
  const me = useApp((s) => s.me);
  const profileId = useApp((s) => s.profileId);
  const form = useFormFactor();
  const all = prefs.settingsMode === 'all';
  const profile = me?.profiles.find((p) => p.id === profileId);

  const sections: { id: string; title: string; body: ReactNode; basic?: boolean }[] = all
    ? [
        { id: 'appearance', title: 'Appearance', body: <Appearance prefs={prefs} all /> },
        { id: 'live', title: 'Live TV', body: <LiveSettings prefs={prefs} form={form} all /> },
        { id: 'player', title: 'Player', body: <PlayerSettings prefs={prefs} all /> },
        { id: 'tabs', title: 'Start & tabs', body: <StartTabs prefs={prefs} all /> },
        { id: 'filters', title: 'Filters', body: <Filters all /> },
        { id: 'buffer', title: 'Rewind buffer', body: <RewindBuffer /> },
        { id: 'profiles', title: 'Profiles', body: <Profiles /> },
        { id: 'source', title: 'Source & account', body: <Source /> },
        { id: 'about', title: 'About', body: <About /> },
      ]
    : [
        { id: 'appearance', title: 'Appearance', body: <Appearance prefs={prefs} /> },
        { id: 'live', title: 'Live TV', body: <LiveSettings prefs={prefs} form={form} /> },
        { id: 'player', title: 'Player', body: <PlayerSettings prefs={prefs} /> },
        { id: 'tabs', title: 'Start', body: <StartTabs prefs={prefs} /> },
        { id: 'filters', title: 'Filters', body: <Filters /> },
      ];

  return (
    <div className="settings">
      {form !== 'phone' && (
        <nav className="set-index" aria-label="Settings sections">
          {sections.map((s) => (
            <a key={s.id} href={`#set-${s.id}`} onClick={(e) => (e.preventDefault(), document.getElementById(`set-${s.id}`)?.scrollIntoView({ behavior: 'smooth' }))}>
              {s.title}
            </a>
          ))}
        </nav>
      )}
      <div className="set-main">
        <div className="page-head">
          <h1 className="h1">Settings</h1>
          <Segmented
            label="Settings mode"
            size="lg"
            value={prefs.settingsMode}
            options={opts<P['settingsMode']>(['basic', 'Basic'], ['all', 'All settings'])}
            onChange={(v) => patchPrefs({ settingsMode: v })}
          />
        </div>
        <p className="muted set-intro pad-x">
          {all ? 'Showing every option.' : 'Showing the essentials. Switch to All settings for everything.'} Settings sync to every device for this profile
          {profile ? ` (${profile.name})` : ''}.
        </p>
        {sections.map((s) => (
          <section key={s.id} id={`set-${s.id}`} className="set-section pad-x" aria-labelledby={`set-h-${s.id}`}>
            <h2 id={`set-h-${s.id}`} className="label">
              {s.title}
            </h2>
            {s.body}
          </section>
        ))}
      </div>
    </div>
  );
}

function Row(props: { label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={`set-row${props.stack ? ' stack' : ''}`}>
      <div className="set-text">
        <div className="set-label">{props.label}</div>
        {props.hint && <div className="set-hint">{props.hint}</div>}
      </div>
      <div className="set-ctl">{props.children}</div>
    </div>
  );
}

/* ---------------- Appearance ---------------- */
function Appearance({ prefs, all }: { prefs: P; all?: boolean }) {
  const a = prefs.appearance;
  const device = useApp((s) => s.deviceOverride);
  return (
    <>
      <Row label="Accent color" hint="Used for progress, focus and the timeline.">
        <div className="swatches" role="radiogroup" aria-label="Accent color" data-nav-row="accent">
          {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={a.accent === id}
              aria-label={ACCENTS[id].name}
              title={ACCENTS[id].name}
              className="swatch"
              style={{ background: ACCENTS[id].hex, ['--sw' as string]: ACCENTS[id].hex }}
              onClick={() => setPref('appearance', { accent: id })}
            />
          ))}
        </div>
      </Row>
      {all && (
        <>
          <Row label="Theme" hint="Black uses true black for OLED screens.">
            <Segmented label="Theme" value={a.theme} options={opts<P['appearance']['theme']>(['dark', 'Dark'], ['black', 'Black'], ['dim', 'Dim'])} onChange={(v) => setPref('appearance', { theme: v })} />
          </Row>
          <Row label="Text size">
            <Segmented
              label="Text size"
              value={a.textSize}
              options={opts<P['appearance']['textSize']>(['small', 'S'], ['medium', 'M'], ['large', 'L'], ['xlarge', 'XL'])}
              onChange={(v) => setPref('appearance', { textSize: v })}
            />
          </Row>
          <Row label="Density" hint="How tightly lists and the guide are packed.">
            <Segmented label="Density" value={a.density} options={opts<P['appearance']['density']>(['comfortable', 'Comfortable'], ['compact', 'Compact'])} onChange={(v) => setPref('appearance', { density: v })} />
          </Row>
          <Row label="Artwork" hint="Posters and logos. Off saves data and shows quiet placeholders.">
            <Toggle label="Show artwork" checked={a.showArtwork} onChange={(v) => setPref('appearance', { showArtwork: v })} />
          </Row>
          <Row label="Animations" hint="Reduced is used automatically when your system asks for less motion.">
            <Segmented label="Animations" value={a.animations} options={opts<P['appearance']['animations']>(['full', 'Full'], ['reduced', 'Reduced'], ['off', 'Off'])} onChange={(v) => setPref('appearance', { animations: v })} />
          </Row>
          <Row label="Device" hint="This device only. Auto picks TV on Android TV, Tizen, webOS and Fire TV.">
            <Segmented label="Device" value={device} options={opts<DeviceOverride>(['auto', 'Auto'], ['phone', 'Phone'], ['desktop', 'Desktop'], ['tv', 'TV'])} onChange={setDeviceOverride} />
          </Row>
        </>
      )}
    </>
  );
}

/* ---------------- Live TV ---------------- */
function LayoutPreviews(props: { value: 'simple' | 'extended'; onChange: (v: 'simple' | 'extended') => void }) {
  return (
    <div className="layout-previews" role="radiogroup" aria-label="Live TV layout" data-nav-row="layout-previews">
      {(['simple', 'extended'] as const).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={props.value === k} className="layout-card" onClick={() => props.onChange(k)}>
          <span className="lc-title">{k === 'simple' ? 'Simple' : 'Extended'}</span>
          {k === 'simple' ? (
            <span className="lc-art" aria-hidden="true">
              {[0.7, 0.5, 0.8, 0.4].map((w, i) => (
                <span key={i} className="lc-list">
                  <i className="lc-logo" />
                  <i className="lc-bar" />
                  <i className="lc-acc" style={{ width: `${w * 2.5}rem` }} />
                </span>
              ))}
            </span>
          ) : (
            <span className="lc-art lc-grid" aria-hidden="true">
              <i className="lc-now" />
              {[[3, 2, 2], [2, 4, 1], [4, 1, 2], [1, 3, 3]].map((r, i) => (
                <span key={i} className="lc-grow">
                  <i className="lc-logo" />
                  {r.map((f, j) => (
                    <i key={j} className={`lc-cell${(i + j) % 3 === 1 ? ' on' : ''}`} style={{ flex: f }} />
                  ))}
                </span>
              ))}
            </span>
          )}
          <span className="lc-hint">{k === 'simple' ? 'One list with now and next. Fast on phones.' : 'Full guide grid. Tap a past show to watch it.'}</span>
        </button>
      ))}
    </div>
  );
}

function LiveSettings({ prefs, form, all }: { prefs: P; form: FormFactor; all?: boolean }) {
  const l = prefs.live;
  const layoutOpts = opts<'simple' | 'extended'>(['simple', 'Simple'], ['extended', 'Extended']);
  return (
    <>
      <Row label={`Live TV layout · this ${FORM_NAME[form]}`} hint="Simple is a channel list with now and next. Extended is the full guide grid." stack>
        <LayoutPreviews value={l[LAYOUT_KEY[form]]} onChange={(v) => setPref('live', { [LAYOUT_KEY[form]]: v })} />
      </Row>
      {all && (
        <>
          {(['phone', 'large', 'tv'] as const)
            .filter((f) => f !== form)
            .map((f) => (
              <Row key={f} label={`Layout on ${FORM_NAME[f]}`} hint="Each kind of device can have its own layout.">
                <Segmented label={`Layout on ${FORM_NAME[f]}`} value={l[LAYOUT_KEY[f]]} options={layoutOpts} onChange={(v) => setPref('live', { [LAYOUT_KEY[f]]: v })} />
              </Row>
            ))}
          <Row label="Guide shows" hint="Hours visible at once in the Extended layout.">
            <Segmented label="Guide hours" value={l.guideHoursVisible} options={opts<2 | 3 | 4 | 6>([2, '2 h'], [3, '3 h'], [4, '4 h'], [6, '6 h'])} onChange={(v) => setPref('live', { guideHoursVisible: v })} />
          </Row>
          <Row label="Only channels with a guide" hint="Hide channels without guide data in Live TV lists and the guide. Many providers have guide data for few channels.">
            <Toggle label="Only channels with a guide" checked={l.guideOnlyWithEpg} onChange={(v) => setPref('live', { guideOnlyWithEpg: v })} />
          </Row>
          <Row label="Channel numbers">
            <Toggle label="Channel numbers" checked={l.showChannelNumbers} onChange={(v) => setPref('live', { showChannelNumbers: v })} />
          </Row>
          <Row label="Channel logos">
            <Toggle label="Channel logos" checked={l.showLogos} onChange={(v) => setPref('live', { showLogos: v })} />
          </Row>
          <Row label="Programme progress" hint="The thin bar under what's on now.">
            <Toggle label="Programme progress" checked={l.showProgress} onChange={(v) => setPref('live', { showProgress: v })} />
          </Row>
          <Row label="Reopen last channel" hint="Start the app on the channel you watched last.">
            <Toggle label="Reopen last channel" checked={l.reopenLastChannel} onChange={(v) => setPref('live', { reopenLastChannel: v })} />
          </Row>
        </>
      )}
    </>
  );
}

/* ---------------- Player ---------------- */
function LangSelect(props: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <select className="input set-select" aria-label={props.label} value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value || null)}>
      <option value="">Stream default</option>
      {COMMON_LANGUAGES.map((c) => (
        <option key={c} value={c}>
          {languageName(c)}
        </option>
      ))}
    </select>
  );
}

function PlayerSettings({ prefs, all }: { prefs: P; all?: boolean }) {
  const p = prefs.player;
  return (
    <>
      <Row label="Autoplay next episode" hint={p.autoplayNext ? `Starts after a ${p.autoplayCountdown} s countdown.` : 'Off: playback stops at the end of an episode.'}>
        <Toggle label="Autoplay next episode" checked={p.autoplayNext} onChange={(v) => setPref('player', { autoplayNext: v })} />
      </Row>
      {all && (
        <>
          <Row label="Countdown before next episode">
            <Segmented
              label="Countdown"
              value={p.autoplayCountdown}
              options={opts<number>([0, 'None'], [5, '5 s'], [10, '10 s'], [15, '15 s'], [20, '20 s'], [30, '30 s'])}
              onChange={(v) => setPref('player', { autoplayCountdown: v })}
            />
          </Row>
          <Row label="Skip back" hint="Left arrow, J, double-tap left, remote left.">
            <Segmented label="Skip back" value={p.skipBackSeconds} options={opts<5 | 10 | 15 | 30>([5, '5 s'], [10, '10 s'], [15, '15 s'], [30, '30 s'])} onChange={(v) => setPref('player', { skipBackSeconds: v })} />
          </Row>
          <Row label="Skip forward" hint="Right arrow, L, double-tap right, remote right.">
            <Segmented label="Skip forward" value={p.skipForwardSeconds} options={opts<10 | 15 | 30 | 60>([10, '10 s'], [15, '15 s'], [30, '30 s'], [60, '60 s'])} onChange={(v) => setPref('player', { skipForwardSeconds: v })} />
          </Row>
          <Row label="Timeline" hint="What appears under the video on live channels.">
            <Segmented label="Timeline style" value={p.timelineStyle} options={opts<P['player']['timelineStyle']>(['ribbon', 'With programme blocks'], ['bar', 'Bar only'])} onChange={(v) => setPref('player', { timelineStyle: v })} />
          </Row>
          <Row label="Subtitles">
            <Segmented label="Subtitles" value={p.subtitlesDefault} options={opts<P['player']['subtitlesDefault']>(['off', 'Off'], ['auto', 'Auto'], ['on', 'Always'])} onChange={(v) => setPref('player', { subtitlesDefault: v })} />
          </Row>
          <Row label="Preferred audio language" hint="Picked automatically when a stream has several.">
            <LangSelect label="Preferred audio language" value={p.preferredAudioLanguage} onChange={(v) => setPref('player', { preferredAudioLanguage: v })} />
          </Row>
          <Row label="Preferred subtitle language">
            <LangSelect label="Preferred subtitle language" value={p.preferredSubtitleLanguage} onChange={(v) => setPref('player', { preferredSubtitleLanguage: v })} />
          </Row>
        </>
      )}
    </>
  );
}

/* ---------------- Start & tabs ---------------- */
function StartTabs({ prefs, all }: { prefs: P; all?: boolean }) {
  const s = prefs.start;
  const vis = visibleTabs(s.tabOrder, s.hiddenTabs);
  const order: TabId[] = [...s.tabOrder, ...(['live', 'movies', 'series', 'search'] as TabId[]).filter((t) => !s.tabOrder.includes(t))];
  const [drag, setDrag] = useState<TabId | null>(null);
  const move = (id: TabId, to: number) => {
    const next = order.filter((t) => t !== id);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
    setPref('start', { tabOrder: next });
  };
  const setHidden = (id: TabId, hide: boolean) => {
    const hidden = hide ? [...s.hiddenTabs, id] : s.hiddenTabs.filter((t) => t !== id);
    if (visibleTabs(order, hidden).length === 0 || hidden.length >= 4) return toast('Keep at least one tab visible.');
    const patch: Partial<P['start']> = { hiddenTabs: hidden };
    if (hide && s.startTab === id) patch.startTab = visibleTabs(order, hidden)[0]!;
    setPref('start', patch);
  };
  return (
    <>
      <Row label="Open the app on">
        <Segmented label="Start tab" value={vis.includes(s.startTab) ? s.startTab : vis[0]!} options={vis.map((t) => ({ value: t, label: TABS[t].short }))} onChange={(v) => setPref('start', { startTab: v })} />
      </Row>
      {all && (
        <Row label="Tab order and visible tabs" hint="Drag, or use the arrows, to reorder. Settings is always shown." stack>
          <ol className="tab-order">
            {order.map((id, i) => (
              <li
                key={id}
                draggable
                onDragStart={(e) => (setDrag(id), e.dataTransfer.setData('text/plain', id))}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => (e.preventDefault(), drag && move(drag, i), setDrag(null))}
                onDragEnd={() => setDrag(null)}
                className={drag === id ? 'dragging' : undefined}
                data-nav-row={`tab-${id}`}
              >
                <IconDrag />
                <span className="to-name">{TABS[id].label}</span>
                <button type="button" className="icon-btn sm" aria-label={`Move ${TABS[id].label} up`} disabled={i === 0} onClick={() => move(id, i - 1)}>
                  <IconUp />
                </button>
                <button type="button" className="icon-btn sm" aria-label={`Move ${TABS[id].label} down`} disabled={i === order.length - 1} onClick={() => move(id, i + 1)}>
                  <IconDown />
                </button>
                <Toggle label={`Show ${TABS[id].label}`} checked={!s.hiddenTabs.includes(id)} onChange={(v) => setHidden(id, !v)} />
              </li>
            ))}
          </ol>
        </Row>
      )}
    </>
  );
}

/* ---------------- Filters ---------------- */
function TagChips(props: { kind: 'languages' | 'countries'; rules: HideRules; tags: { code: string; count: number }[] }) {
  const hidden = props.rules[props.kind];
  const name = props.kind === 'languages' ? languageName : countryName;
  const toggle = (code: string) => {
    const next = hidden.includes(code) ? hidden.filter((c) => c !== code) : [...hidden, code];
    void saveHideRules({ ...props.rules, [props.kind]: next });
  };
  return (
    <div className="lang-grid" role="group" aria-label={props.kind} data-nav-row={`tags-${props.kind}`}>
      {props.tags.map((t) => {
        const isHidden = hidden.includes(t.code);
        return (
          <button key={t.code} type="button" className={`chip${isHidden ? ' hidden-tag' : ''}`} aria-pressed={!isHidden} onClick={() => toggle(t.code)} aria-label={`${name(t.code)}: ${isHidden ? 'hidden' : 'shown'}`}>
            {name(t.code)} <span className="count">{t.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function Filters({ all }: { all?: boolean }) {
  const rules = useApp((s) => s.hideRules);
  const tags = useAsync(() => cachedGet('GET /api/tags', {}, 300_000), []);
  const langs = (tags.data?.languages ?? []).filter((t) => t.language).map((t) => ({ code: t.language!, count: t.count }));
  const countries = (tags.data?.countries ?? []).filter((t) => t.country).map((t) => ({ code: t.country!, count: t.count }));
  const loading = tags.loading && !tags.data;
  return (
    <>
      <Row label="Languages" hint="Crossed-out languages are hidden everywhere: tabs, guide and search." stack>
        {loading ? <Skeleton h="2.25rem" /> : tags.error ? <p className="notice error">{errorMessage(tags.error)}</p> : <TagChips kind="languages" rules={rules} tags={langs} />}
      </Row>
      <Row label="Countries" hint="Hide channel groups and titles from whole countries." stack>
        {loading ? <Skeleton h="2.25rem" /> : <TagChips kind="countries" rules={rules} tags={countries} />}
      </Row>
      {all && <CategoryFilter rules={rules} />}
    </>
  );
}

function CategoryFilter({ rules }: { rules: HideRules }) {
  const [kind, setKind] = useState<MediaKind>('live');
  const [q, setQ] = useState('');
  const cats = useAsync(() => cachedGet('GET /api/categories', { query: { kind, all: '1' } }, 300_000), [kind]);
  const list = (cats.data ?? []).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: string, hide: boolean) =>
    void saveHideRules({ ...rules, categoryIds: hide ? [...rules.categoryIds, id] : rules.categoryIds.filter((c) => c !== id) });
  const hiddenCount = (cats.data ?? []).filter((c) => rules.categoryIds.includes(c.id)).length;
  return (
    <Row label="Categories" hint={`${hiddenCount} hidden in ${kind === 'live' ? 'Live TV' : kind === 'movie' ? 'Movies' : 'Series'}.`} stack>
      <div className="cat-filter">
        <div className="cat-tools">
          <Segmented label="Category type" value={kind} options={opts<MediaKind>(['live', 'Live TV'], ['movie', 'Movies'], ['series', 'Series'])} onChange={setKind} />
          <input className="input" placeholder="Filter categories" aria-label="Filter categories" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="cat-list">
          {cats.loading && !cats.data
            ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h="2.5rem" />)
            : list.map((c) => {
                const byTag = (c.language && rules.languages.includes(c.language)) || (c.country && rules.countries.includes(c.country));
                return (
                  <div key={c.id} className="cat-item">
                    <span className="ellipsis">{c.name}</span>
                    {byTag ? (
                      <span className="muted" style={{ fontSize: '0.8125rem' }}>
                        Hidden by language/country
                      </span>
                    ) : (
                      <Toggle label={`Show ${c.name}`} checked={!rules.categoryIds.includes(c.id)} onChange={(v) => toggle(c.id, !v)} />
                    )}
                  </div>
                );
              })}
        </div>
      </div>
    </Row>
  );
}

/* ---------------- Profiles ---------------- */
function Profiles() {
  const me = useApp((s) => s.me);
  const current = useApp((s) => s.profileId);
  const list = useAsync(() => call('GET /api/profiles'), []);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const profiles = list.data ?? me?.profiles ?? [];
  const sync = (ps: Profile[]) => me && useApp.setState({ me: { ...me, profiles: ps } });
  useEffect(() => {
    if (list.data) sync(list.data);
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      list.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <>
      <div className="profile-list">
        {profiles.map((p) => (
          <div key={p.id} className="set-row" data-nav-row={`profile-${p.id}`}>
            <span className="avatar">{p.name.slice(0, 1).toUpperCase()}</span>
            {editing === p.id ? (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.trim()) void run(() => call('PATCH /api/profiles/:id', { params: { id: p.id }, body: { name: draft.trim() } }));
                  setEditing(null);
                }}
              >
                <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Profile name" autoFocus maxLength={40} />
                <button className="btn btn-primary" type="submit">
                  Save
                </button>
                <button className="btn" type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <div className="set-text">
                  <div className="set-label">{p.name}</div>
                  {p.id === current && <div className="set-hint">Watching now</div>}
                </div>
                <div className="set-ctl row-actions">
                  {p.id !== current && (
                    <button className="btn" type="button" onClick={() => selectProfile(p.id)}>
                      Switch
                    </button>
                  )}
                  <button className="btn" type="button" onClick={() => (setEditing(p.id), setDraft(p.name))}>
                    Rename
                  </button>
                  {profiles.length > 1 &&
                    (confirm === p.id ? (
                      <>
                        <button
                          className="btn btn-danger"
                          type="button"
                          onClick={() => {
                            setConfirm(null);
                            void run(async () => {
                              await call('DELETE /api/profiles/:id', { params: { id: p.id } });
                              if (p.id === current) {
                                const other = profiles.find((x) => x.id !== p.id);
                                if (other) selectProfile(other.id);
                              }
                            });
                          }}
                        >
                          Delete {p.name}
                        </button>
                        <button className="btn" type="button" onClick={() => setConfirm(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <button className="btn" type="button" onClick={() => setConfirm(p.id)}>
                        Delete
                      </button>
                    ))}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <form
        className="inline-form"
        style={{ marginTop: '1rem' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void run(() => call('POST /api/profiles', { body: { name: name.trim() } }));
          setName('');
        }}
      >
        <input className="input" placeholder="New profile name" aria-label="New profile name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
          Add profile
        </button>
      </form>
      <p className="set-hint" style={{ marginTop: '0.75rem' }}>
        Profiles share this login and TV source. Each has its own favorites, progress, settings and filters.
      </p>
    </>
  );
}

/* ---------------- Rewind buffer ---------------- */
function RewindBuffer() {
  const isAdmin = useApp((s) => s.me?.user.isAdmin ?? false);
  const [tick, setTick] = useState(0);
  const st = useAsync(() => call('GET /api/buffer/status'), [tick]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  if (st.error) {
    const off = st.error instanceof ApiError && st.error.status === 404;
    return <p className={`notice${off ? '' : ' error'}`}>{off ? 'The rewind buffer is turned off on this server.' : `Couldn't read the buffer status: ${errorMessage(st.error)}`}</p>;
  }
  const s = st.data;
  if (!s) return <Skeleton h="8rem" />;
  if (!s.enabled) return <p className="notice">The rewind buffer is turned off on this server.</p>;
  const pinned = s.channels.filter((c) => c.pinned);
  const unpin = async (id: string) => {
    setBusy(id);
    setMsg(null);
    try {
      await setBufferPin(id, false);
      setTick((x) => x + 1);
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <p className="set-hint" style={{ marginBottom: '0.5rem' }}>
        The server records live channels while someone watches them, so you can rewind even where the provider has no archive.
      </p>
      <Row label="Space used" hint={`Up to ${s.caps.maxHoursPerChannel} h per channel. The oldest recordings are removed first.`}>
        <div className="buf-total">
          <span className="tabnum">
            {fmtBytes(s.totalBytes)} of {fmtBytes(s.caps.maxBytes)}
          </span>
          <ProgressBar value={s.caps.maxBytes ? s.totalBytes / s.caps.maxBytes : 0} label="Rewind buffer space used" />
        </div>
      </Row>
      {s.caps.maxPins === 0 && !pinned.length ? (
        <Row
          label="Always buffered"
          hint="Your subscription plays one stream at a time. That connection stays free for watching, so no channel can keep a buffer in the background. The channel you watch is still buffered while you watch it."
        >
          <span className="muted">Not available</span>
        </Row>
      ) : (
        <Row
          label="Always buffered"
          hint={
            isAdmin
              ? 'Pin a channel from its player with "Keep a rewind buffer". Each pinned channel uses one provider connection; one always stays free for watching.'
              : 'Only an admin can choose which channels are always buffered.'
          }
        >
          <span className="tabnum">
            {pinned.length} of {s.caps.maxPins ?? '?'} channel{s.caps.maxPins === 1 ? '' : 's'}
          </span>
        </Row>
      )}
      {msg && (
        <p className="notice error" role="alert">
          {msg}
        </p>
      )}
      <div className="buf-list" aria-label="Buffered channels" role="list">
        {s.channels.length === 0 && <p className="muted">Nothing buffered yet.</p>}
        {s.channels.map((c) => (
          <div key={c.channelId} role="listitem" className="set-row" data-nav-row={`buf-${c.channelId}`}>
            <div className="set-text">
              <div className="set-label">{c.name ?? `Channel ${c.channelId}`}</div>
              <div className="set-hint tabnum">
                {[fmtLength(c.durationMs / 1000), fmtBytes(c.bytes), c.recording ? 'recording' : null, c.pinned ? 'pinned' : null].filter(Boolean).join(' · ')}
              </div>
            </div>
            {c.pinned && isAdmin && (
              <div className="set-ctl">
                <button type="button" className="btn" disabled={busy === c.channelId} onClick={() => void unpin(c.channelId)} aria-label={`Unpin ${c.name ?? c.channelId}`}>
                  Unpin
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------- Source ---------------- */
function Source() {
  const [tick, setTick] = useState(0);
  const st = useAsync(() => call('GET /api/source'), [tick]);
  const s = st.data;
  useEffect(() => {
    if (!s?.syncing) return;
    const t = setTimeout(() => setTick((x) => x + 1), 2000);
    return () => clearTimeout(t);
  }, [s]);
  if (st.error) return <p className="notice error">Couldn't read the source status: {errorMessage(st.error)}</p>;
  if (!s) return <Skeleton h="8rem" />;
  const acc = s.account;
  return (
    <>
      <Row label="Provider" hint="Details stay on your server and are never shown here.">
        <span className={s.configured ? 'status-ok' : 'status-bad'}>{s.configured ? 'Connected' : 'Not configured'}</span>
      </Row>
      {acc && (
        <>
          <Row label="Account">
            <span>{acc.status}</span>
          </Row>
          <Row label="Expires">
            <span className="tabnum">{acc.expiresAt ? new Date(acc.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : 'Never'}</span>
          </Row>
          <Row label="Connections" hint="Streams your provider allows at the same time.">
            <span className="tabnum">
              {acc.activeConnections ?? '?'} of {acc.maxConnections ?? '?'} in use
            </span>
          </Row>
        </>
      )}
      <Row label="Catalog" hint={`${s.counts.live.toLocaleString()} channels · ${s.counts.movie.toLocaleString()} movies · ${s.counts.series.toLocaleString()} series`}>
        <span className="muted">{s.lastSync.catalog ? `Updated ${fmtRelativeAgo(s.lastSync.catalog)}` : 'Never synced'}</span>
      </Row>
      <Row label="TV guide">
        <span className="muted">{s.lastSync.epg ? `Updated ${fmtRelativeAgo(s.lastSync.epg)}` : 'Never synced'}</span>
      </Row>
      <Row label="Sync now" hint="Reload channels, movies, series and the guide from your provider.">
        <button
          type="button"
          className="btn"
          disabled={s.syncing}
          onClick={() =>
            call('POST /api/source/sync').then(
              () => (toast('Sync started'), setTick((x) => x + 1)),
              (e) => toast(errorMessage(e), 'error'),
            )
          }
        >
          <IconRefresh /> {s.syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </Row>
    </>
  );
}

/* ---------------- About ---------------- */
function About() {
  const health = useAsync(() => call('GET /api/health'), []);
  const caps = useMemo(() => {
    try {
      return JSON.parse(capsHeader() ?? '{}') as { hls?: boolean; mse?: boolean; codecs?: string[] };
    } catch {
      return {};
    }
  }, []);
  const [confirmReset, setConfirmReset] = useState(false);
  return (
    <>
      <Row label="AnyCast app" hint={isDemo() ? 'Demo mode: fixture data, nothing is saved.' : undefined}>
        <span className="tabnum">{__APP_VERSION__}</span>
      </Row>
      <Row label="Server">
        <span className="tabnum">{health.data?.version ?? (health.error ? 'Unreachable' : '…')}</span>
      </Row>
      <Row label="This browser can play" hint="Sent to the server so it only converts what this device can't play.">
        <span className="muted caps">
          {[caps.mse ? 'MSE' : null, caps.hls ? 'native HLS' : null, ...(caps.codecs ?? [])].filter(Boolean).join(' · ') || 'Basic playback only'}
        </span>
      </Row>
      <Row label="Reset settings" hint="Puts every setting for this profile back to its default. Filters and favorites stay.">
        {confirmReset ? (
          <span className="row-actions">
            <button type="button" className="btn btn-danger" onClick={() => (patchPrefs({ ...structuredClone(DEFAULT_PREFERENCES), setupDone: true }), setConfirmReset(false))}>
              Reset everything
            </button>
            <button type="button" className="btn" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirmReset(true)}>
            Reset…
          </button>
        )}
      </Row>
      <Row label="Sign out" hint="Signs this device out. Other devices stay signed in.">
        <button type="button" className="btn" onClick={() => void logout()}>
          Sign out
        </button>
      </Row>
    </>
  );
}
