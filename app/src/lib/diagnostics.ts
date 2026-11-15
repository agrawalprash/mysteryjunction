// Collects facts about this device's voice setup and asks Claude what's wrong.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { diagnoseDevice, type DiagnosisResult } from './claude.ts';
import { claudeAuth, type ApiKeys } from './keys.ts';

interface DiagnosticsPlugin {
  collect(): Promise<Record<string, unknown>>;
  speechTest(opts: { language?: string }): Promise<Record<string, unknown>>;
}
declare const __APP_VERSION__: string;

const Diagnostics = registerPlugin<DiagnosticsPlugin>('WanderDiagnostics');

export const DEFAULT_SYMPTOMS =
  'Voice input does not work on this TV. Pressing the Assistant button on the remote opens a listening screen and the remote shows a red light, but nothing is ever heard. ' +
  'The same happens with the mic in the Google TV app on my phone. The remote is paired over Bluetooth (shows as connected, battery ~42%). ' +
  'I updated the Google app and checked that microphone permissions are allowed. Voice in YouTube stopped working a while ago too.';

export interface DiagnosisRun {
  report: Record<string, unknown>;
  diagnosis: DiagnosisResult;
}

export async function runDiagnosis(keys: ApiKeys, symptoms: string, onProgress: (msg: string) => void): Promise<DiagnosisRun> {
  if (!Capacitor.isNativePlatform()) throw new Error('Diagnosis only works in the installed app.');
  const auth = claudeAuth(keys);
  if (!auth) throw new Error('Diagnosis needs an Anthropic key.');
  onProgress('Looking at the device…');
  const report = await Diagnostics.collect();
  onProgress('Running a live speech test: say something now…');
  let speech: Record<string, unknown>;
  try {
    speech = await Diagnostics.speechTest({ language: 'en-US' });
  } catch (e) {
    speech = { ok: false, errorName: String(e) };
  }
  report.liveSpeechTest = speech;
  report.wanderVersion = __APP_VERSION__;
  onProgress('Claude is reading the report…');
  const diagnosis = await diagnoseDevice(auth, report, symptoms);
  return { report, diagnosis };
}
