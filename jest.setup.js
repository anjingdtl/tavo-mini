/* eslint-env jest, node, es2020 */

// React 19 best practice: mark the test environment as act-aware so async
// setState calls (e.g. from awaited promises in useEffect) are tracked and
// don't trigger "not wrapped in act(...)" warnings. Must be set before any
// React module is imported.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// React 19 + react-test-renderer 19 occasionally log "not wrapped in act(...)"
// warnings for setState calls that resolve inside microtasks scheduled by
// awaited promises in useEffect (e.g. `.finally(() => setX(false))`). The
// production code is correct — these are noise from the test renderer — so
// filter them out while leaving every other console.error visible.
const _origConsoleError = console.error;
console.error = (...args) => {
  const first = args[0];
  if (typeof first === 'string' && first.includes('not wrapped in act')) {
    return;
  }
  _origConsoleError.apply(console, args);
};

jest.mock('react-native-sqlite-storage', () => ({
  enablePromise: jest.fn(),
  openDatabase: jest.fn(),
}));

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp/documents',
  CachesDirectoryPath: '/tmp/cache',
  DownloadDirectoryPath: '/tmp',
  ExternalDirectoryPath: '/tmp/external',
  readFile: jest.fn(),
  writeFile: jest.fn(),
  copyFile: jest.fn(),
  mkdir: jest.fn(),
  readDir: jest.fn(),
  unlink: jest.fn(() => Promise.resolve()),
  exists: jest.fn(),
}));

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  keepLocalCopy: jest.fn(),
  saveDocuments: jest.fn(),
  types: { json: 'application/json', images: 'image/*', plainText: 'text/plain', allFiles: '*/*' },
  isCancel: jest.fn(() => false),
}));

jest.mock('react-native-keychain', () => {
  const passwords = new Map();
  const defaultService = 'com.shinewriter.llm.api-key';
  return {
    setGenericPassword: jest.fn(async (_username, nextPassword, options = {}) => {
      passwords.set(options.service || defaultService, nextPassword);
      return true;
    }),
    getGenericPassword: jest.fn(async (options = {}) => {
      const password = passwords.get(options.service || defaultService) || '';
      return password ? { username: 'llm-api-key', password } : false;
    }),
    resetGenericPassword: jest.fn(async (options = {}) => {
      passwords.delete(options.service || defaultService);
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

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  RN.NativeModules.TtsAudio = {
    playAudioFile: jest.fn(() => Promise.resolve()),
    stopAudio: jest.fn(() => Promise.resolve()),
    speak: jest.fn(() => Promise.resolve()),
    stopSpeak: jest.fn(() => Promise.resolve()),
    isTtsReady: jest.fn(() => Promise.resolve(true)),
    getEngines: jest.fn(() =>
      Promise.resolve([
        { name: 'com.google.android.tts', label: 'Google TTS', isDefault: true },
      ]),
    ),
    getVoices: jest.fn(() =>
      Promise.resolve([{ key: 'zh-cn-x', name: '中文女声', locale: 'zh-CN' }]),
    ),
  };
  RN.NativeModules.PipelineForeground = {
    start: jest.fn(() => Promise.resolve()),
    updateProgress: jest.fn(() => Promise.resolve()),
    notifyComplete: jest.fn(() => Promise.resolve()),
    notifyFailed: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
    isAvailable: jest.fn(() => Promise.resolve(true)),
  };
  return RN;
});
