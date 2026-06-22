import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { App } from '../src/main';

jest.mock('../src/services/database', () => ({
  getAllProjects: jest.fn(async () => []),
  getSetting: jest.fn(async () => null),
  openDatabase: jest.fn(),
}));

test('renders the real ShineWriter workspace tabs', async () => {
  const screen = render(<App />);

  await waitFor(() => {
    expect(screen.getByText('项目')).toBeTruthy();
    expect(screen.getByText('写作')).toBeTruthy();
    expect(screen.getByText('资料')).toBeTruthy();
    expect(screen.getByText('设置')).toBeTruthy();
  }, { timeout: 2500 });
});
