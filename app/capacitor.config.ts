import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.agrawalprash.wander',
  appName: 'Wander',
  webDir: 'dist',
  server: {
    // YouTube's embedded player rejects pages without a real-looking origin
    // (error 152/153). Serving the bundled app under this hostname gives the
    // player a proper Referer while still loading everything from the APK.
    hostname: 'agrawalprash.github.io',
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#0f0f0f',
  },
};

export default config;
