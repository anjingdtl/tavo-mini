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
  if (
    typeof first === 'string' &&
    (first.includes('not wrapped in act') ||
      first.includes('current testing environment is not configured to support act'))
  ) {
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
  moveFile: jest.fn(),
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
  errorCodes: { OPERATION_CANCELED: 'OPERATION_CANCELED' },
  isErrorWithCode: jest.fn(error => Boolean(error && error.code)),
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
  const ttsListeners = new Map();
  RN.NativeModules.TtsAudio = {
    beginBackgroundPlayback: jest.fn(() => Promise.resolve()),
    endBackgroundPlayback: jest.fn(() => Promise.resolve()),
    playAudioFile: jest.fn(() => Promise.resolve()),
    stopAudio: jest.fn(() => Promise.resolve()),
    speak: jest.fn(() => Promise.resolve()),
    stopSpeak: jest.fn(() => Promise.resolve()),
    isTtsReady: jest.fn(() => Promise.resolve(true)),
    getEngines: jest.fn(() =>
      Promise.resolve([
        { name: 'com.google.android.tts', label: 'Google TTS', isDefault: true, isCurrent: true },
      ]),
    ),
    getVoices: jest.fn(() =>
      Promise.resolve([
        { key: 'zh-cn-x', name: '中文女声', locale: 'zh-CN', quality: 300, latency: 200, requiresNetwork: false, features: [] },
      ]),
    ),
    getDiagnostics: jest.fn(() =>
      Promise.resolve({
        initialized: true,
        manufacturer: 'Google',
        model: 'sdk_gphone64_arm64',
        androidVersion: '14',
        sdkInt: 34,
        requestedEngine: '',
        currentEngine: 'com.google.android.tts',
        defaultEngine: 'com.google.android.tts',
        installedEngineCount: 1,
        selectedEngineInstalled: true,
        language: 'zh-CN',
        languageStatus: 'available',
        voiceCount: 1,
        matchingVoiceCount: 1,
        offlineVoiceCount: 1,
        maxInputLength: 4000,
      }),
    ),
    installTtsData: jest.fn(() => Promise.resolve(true)),
    openTtsSettings: jest.fn(() => Promise.resolve(true)),
    addListener: jest.fn((eventName) => {
      ttsListeners.set(eventName, (ttsListeners.get(eventName) || []).concat(jest.fn()));
    }),
    removeListeners: jest.fn(),
    __emitTtsEvent: (eventName, data) => {
      RN.DeviceEventEmitter.emit(eventName, data);
    },
  };
  RN.NativeModules.PipelineForeground = {
    start: jest.fn(() => Promise.resolve()),
    updateProgress: jest.fn(() => Promise.resolve()),
    notifyComplete: jest.fn(() => Promise.resolve()),
    notifyFailed: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
    isAvailable: jest.fn(() => Promise.resolve(true)),
    consumeDeepLinkTaskId: jest.fn(() => Promise.resolve(null)),
  };
  // 10.13 修复：补充 PngMetadata 原生模块 mock，避免导入角色卡 PNG 时 NativeModules.PngMetadata 为 undefined
  RN.NativeModules.PngMetadata = {
    parsePngMetadata: jest.fn(() => Promise.resolve([])),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  // Schema 19: continuation TXT import native module (chunked GBK/GB18030/UTF-16 decoder)
  RN.NativeModules.ContinuationTextImport = {
    detectEncoding: jest.fn(() =>
      Promise.resolve({ encoding: 'utf-8', confidence: 1.0, hasBom: false, fileSizeBytes: 0 }),
    ),
    readFileMeta: jest.fn(() => Promise.resolve({ fileSizeBytes: 0, canRead: true })),
    decodeChunk: jest.fn(() =>
      Promise.resolve({ text: '', nextByteOffset: 0, decodedChars: 0, bytesConsumed: 0, atEof: true }),
    ),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  // llama.cpp 本地模型原生模块 mock
  RN.NativeModules.LlamaCpp = {
    getCapabilities: jest.fn(() =>
      Promise.resolve({ available: true, cpuSupported: true, freeMemoryMB: 4096, totalMemoryMB: 8192 }),
    ),
    importModel: jest.fn((_uri, originalFilename, displayName) =>
      Promise.resolve({
        importId: 'import-test',
        originalFilename,
        displayName,
        fileSize: 0,
        sha256: 'sha-test',
        stagingRelativePath: 'test/test.gguf',
      }),
    ),
    validateModel: jest.fn(() => Promise.resolve({ backend: 'cpu', loadTimeMs: 100 })),
    loadModel: jest.fn(() => Promise.resolve({ backend: 'cpu', loadTimeMs: 100 })),
    generate: jest.fn(() => Promise.resolve(null)),
    cancel: jest.fn(() => Promise.resolve(null)),
    unloadModel: jest.fn(() => Promise.resolve(null)),
    deleteModelFiles: jest.fn(() => Promise.resolve(null)),
    modelFileExists: jest.fn(() => Promise.resolve(true)),
    cleanupStagingFiles: jest.fn(() => Promise.resolve(0)),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    __emitLlamaCppEvent: (eventName, data) => {
      RN.DeviceEventEmitter.emit(eventName, data);
    },
  };

  return RN;
});
