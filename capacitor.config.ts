import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.qiyen.aster',
  appName: 'Aster 記帳',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#0A0A0C',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
