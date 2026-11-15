// Is this an Android TV? Asked from the native side (see DevicePlugin.java).

import { Capacitor, registerPlugin } from '@capacitor/core';

const WanderDevice = registerPlugin<{ info(): Promise<{ isTv: boolean }> }>('WanderDevice');

export async function detectTv(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    return (await WanderDevice.info()).isTv;
  } catch {
    return false;
  }
}
