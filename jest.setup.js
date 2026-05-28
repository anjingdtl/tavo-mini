/* eslint-env jest */

jest.mock('react-native-sqlite-storage', () => ({
  enablePromise: jest.fn(),
  openDatabase: jest.fn(),
}));

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp/documents',
  CachesDirectoryPath: '/tmp/cache',
  DownloadDirectoryPath: '/tmp',
  readFile: jest.fn(),
  writeFile: jest.fn(),
  copyFile: jest.fn(),
  mkdir: jest.fn(),
}));

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  keepLocalCopy: jest.fn(),
  saveDocuments: jest.fn(),
  types: { json: 'application/json', images: 'image/*', plainText: 'text/plain', allFiles: '*/*' },
  isCancel: jest.fn(() => false),
}));

jest.mock('react-native-keychain', () => {
  let password = '';
  return {
    setGenericPassword: jest.fn(async (_username, nextPassword) => {
      password = nextPassword;
      return true;
    }),
    getGenericPassword: jest.fn(async () => (password ? { username: 'llm-api-key', password } : false)),
    resetGenericPassword: jest.fn(async () => {
      password = '';
      return true;
    }),
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly' },
  };
});

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: Object.assign(() => null, {
    show: jest.fn(),
    hide: jest.fn(),
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaProvider: ({ children }) => React.createElement(React.Fragment, null, children),
    SafeAreaView: ({ children }) => React.createElement(React.Fragment, null, children),
    SafeAreaInsetsContext: React.createContext(insets),
    SafeAreaFrameContext: React.createContext(frame),
    initialWindowMetrics: { insets, frame },
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
  };
});

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Icon = ({ testID }) => React.createElement(Text, { testID }, 'icon');
  return new Proxy({}, { get: () => Icon });
});
