/**
 * Settings › All › Backup & restore (admins): download a backup of AnyCast's own data, download one
 * of the automatic daily backups, or restore from a file. Restoring shows what the file holds and
 * asks for replace or merge and the admin's password first.
 */
import { useRef, useState, type ReactNode } from 'react';
import { backupFileName, type RestoreMode } from '@anycast/shared';
import { call, errorMessage } from '../api/client';
import { fmtBytes } from '../api/buffer';
import { useApp } from '../store/app';
import { loadProfileData, toast } from '../store/actions';
import { loadAdult } from '../store/parental';
import { useAsync } from '../lib/hooks';
import { accountInBackup, describeSummary, fmtBackupDate, readBackup, saveJsonFile, type ReadBackup } from '../lib/backup';
import { Segmented, Skeleton } from '../components/ui';
import { Sheet } from '../components/lists';
import '../theme/backup.css';

type RowComp = (p: { label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }) => JSX.Element;

export function BackupSection({ Row }: { Row: RowComp }) {
  const autos = useAsync(() => call('GET /api/admin/backups'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<(ReadBackup & { fileName: string }) | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    try {
      await f();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  const download = () => run('download', async () => saveJsonFile(backupFileName(Date.now()), await call('GET /api/admin/backup')));
  const downloadAuto = (name: string) => run(name, async () => saveJsonFile(name, await call('GET /api/admin/backups/:name', { params: { name } })));

  const onFile = async (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    setFileError(null);
    try {
      setPicked({ ...readBackup(await file.text()), fileName: file.name });
    } catch (e) {
      setFileError(errorMessage(e));
    }
  };

  const list = autos.data;
  return (
    <div data-testid="backup">
      <Row label="Download a backup" hint="Accounts, profiles, favorites, progress, channel lists and settings in one file. It never contains your provider login.">
        <button type="button" className="btn" onClick={() => void download()} disabled={busy === 'download'} aria-busy={busy === 'download' || undefined}>
          Download backup
        </button>
      </Row>
      <Row
        label="Restore"
        hint="From a backup file of this or another AnyCast server. You'll see what it holds before anything changes. Favorites and lists of channels that aren't synced yet come back once they are."
      >
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="sr-only"
          tabIndex={-1}
          data-nav="off"
          aria-hidden="true"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
          Restore from file…
        </button>
      </Row>
      {fileError && (
        <p className="notice error" role="alert">
          {fileError}
        </p>
      )}
      <Row
        label="Automatic backups"
        hint={
          !list
            ? undefined
            : list.keep > 0
              ? `One a day, the last ${list.keep} kept on the server (in the data folder, under backups). A restore saves the data it replaces there first.`
              : 'Turned off on this server (ANYCAST_BACKUP_KEEP=0).'
        }
        stack
      >
        {autos.error ? (
          <p className="notice error">Couldn't list the automatic backups: {errorMessage(autos.error)}</p>
        ) : !list ? (
          <Skeleton h="3rem" />
        ) : list.files.length === 0 ? (
          <p className="muted">{list.keep > 0 ? 'None yet. The first one is made within the hour.' : 'None.'}</p>
        ) : (
          <ul className="backup-list" aria-label="Automatic backups">
            {list.files.map((f) => (
              <li key={f.name} className="backup-item" data-nav-row={`backup-${f.name}`}>
                <div className="backup-text">
                  <span className="tabnum">{fmtBackupDate(f.createdAt)}</span>
                  <span className="muted backup-meta">
                    {f.name.includes('before-restore') ? 'Before a restore · ' : ''}
                    {fmtBytes(f.bytes)}
                  </span>
                </div>
                <button type="button" className="btn btn-quiet" onClick={() => void downloadAuto(f.name)} disabled={busy === f.name} aria-label={`Download backup of ${fmtBackupDate(f.createdAt)}`}>
                  Download
                </button>
              </li>
            ))}
          </ul>
        )}
      </Row>
      {picked && (
        <RestoreDialog
          picked={picked}
          onClose={() => setPicked(null)}
          onDone={() => {
            setPicked(null);
            autos.reload();
          }}
        />
      )}
    </div>
  );
}

function RestoreDialog(props: { picked: ReadBackup & { fileName: string }; onClose: () => void; onDone: () => void }) {
  const me = useApp((s) => s.me);
  const { backup, summary, fileName } = props.picked;
  const [mode, setMode] = useState<RestoreMode>('replace');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = me ? accountInBackup(backup, me.user) : 'admin';

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await call('POST /api/admin/restore', { body: { backup, mode, password } });
      toast(res.keptCurrentAccount ? 'Backup restored. Your account was kept as it was.' : 'Backup restored.');
      // profiles may have changed: refresh them and this profile's data
      const fresh = await call('GET /api/me').catch(() => null);
      if (fresh) useApp.setState({ me: fresh });
      void loadProfileData();
      void loadAdult({ refresh: true });
      props.onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Sheet title="Restore backup" onClose={props.onClose} className="restore-sheet">
      <form
        className="restore-body"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="restore-file">
          <span className="ellipsis">{fileName}</span>
          <span className="muted">
            Made {fmtBackupDate(backup.createdAt)} · AnyCast {backup.appVersion}
          </span>
        </p>
        <dl className="restore-summary" aria-label="What the backup holds">
          {describeSummary(summary).map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd className="tabnum">{r.value}</dd>
            </div>
          ))}
        </dl>
        <Segmented<RestoreMode>
          label="Restore mode"
          value={mode}
          options={[
            { value: 'replace', label: 'Replace everything' },
            { value: 'merge', label: 'Merge' },
          ]}
          onChange={setMode}
        />
        <p className="set-hint">
          {mode === 'replace'
            ? 'All accounts, profiles and their data on this server are replaced by the backup. Devices signed in to accounts that aren’t in it are signed out.'
            : 'Everything on this server stays as it is. What the backup has and this server doesn’t is added: missing accounts, profiles, favorites, progress and lists.'}
        </p>
        {mode === 'replace' && account !== 'admin' && me && (
          <p className="notice restore-warn" role="alert" data-testid="restore-account-warning">
            {account === 'missing'
              ? `Your account (${me.user.username}) isn't in this backup. It will be kept, with its profiles, so you can still sign in.`
              : `In this backup, ${me.user.username} isn't an admin. You'll stay an admin and keep your current password.`}
          </p>
        )}
        <label className="restore-pw">
          <span className="set-label">Your password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-autofocus=""
            required
          />
        </label>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <div className="restore-actions" data-nav-row="restore-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!password || busy} aria-busy={busy || undefined}>
            {mode === 'replace' ? 'Replace and restore' : 'Merge'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
