import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mktv.app',
  appName: 'MKTV',
  webDir: 'public',
  server: {
    url: 'https://mktv-0617.onrender.com/',
    cleartext: false
  }
};

export default config;
