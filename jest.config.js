module.exports = {
  preset: '@react-native/jest-preset',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/android/app/jni/llama.cpp/',
    '/__tests__/migrationTestUtils.ts$',
  ],
  collectCoverageFrom: [
    'src/services/**/*.ts',
    'src/store/**/*.ts',
    'src/utils/**/*.ts',
    '!**/*.d.ts',
  ],
  coverageReporters: ['text', 'text-summary', 'json-summary', 'lcov'],
  coverageThreshold: {
    global: {
      branches: 55,
      functions: 65,
      lines: 65,
      statements: 65,
    },
    './src/services/database.ts': {
      branches: 70,
      lines: 80,
    },
    './src/services/database/**': {
      branches: 70,
      lines: 80,
    },
    './src/services/migrations/**': {
      branches: 70,
      lines: 80,
    },
    './src/services/backupService.ts': {
      branches: 70,
      lines: 80,
    },
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native|@react-navigation|react-native-screens|react-native-safe-area-context|lucide-react-native|react-native-svg|react-native-keychain|@react-native-documents/picker)/)',
  ],
};
