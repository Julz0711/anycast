/** `pnpm run doctor -- [--samples N] [--json] [--no-streams]` */
import { spawnSync } from 'node:child_process';
import { loadEnvFiles, xtreamFromEnv } from '../config';
import { createRedactor } from '../redact';
import { DoctorAuthError, formatReport, parseArgs, runDoctor } from './report';

async function main(): Promise<number> {
  loadEnvFiles();
  const creds = xtreamFromEnv(process.env);
  if (!creds) {
    console.error('Set XTREAM_URL, XTREAM_USERNAME and XTREAM_PASSWORD in your .env first.');
    return 1;
  }
  const redact = createRedactor(creds);
  const args = parseArgs(process.argv.slice(2));
  if (args.streams && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).error) {
    console.error(
      'ffprobe (part of FFmpeg) was not found, so stream formats are skipped.\n' +
        'Install FFmpeg to include them (Windows: winget install Gyan.FFmpeg, macOS: brew install ffmpeg), then open a new terminal.',
    );
    args.streams = false;
  }
  try {
    if (!args.json) console.error('Checking your provider... (this can take a minute)');
    const report = await runDoctor(creds, args);
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return 0;
  } catch (err) {
    if (err instanceof DoctorAuthError) {
      console.error(`Login to your provider failed: ${redact(err.message)}`);
      return 2;
    }
    console.error(`Doctor failed: ${redact((err as Error).message)}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
