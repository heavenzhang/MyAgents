import { requireNativeModule } from 'expo-modules-core';

/** The only JS boundary. Credentials, keys and SDK handles are native-only. */
export default requireNativeModule<{
  request(intentJSON: string): Promise<string>;
  addListener(event: 'snapshotChanged', listener: (hint: {
    targetId: string; agentId: string; sessionId: string;
  }) => void): { remove(): void };
}>('MoxBotsRemote');
