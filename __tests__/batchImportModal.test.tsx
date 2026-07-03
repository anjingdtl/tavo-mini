import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { BatchImportResultModal } from '../src/components/BatchImportResultModal';

describe('BatchImportResultModal', () => {
  test('renders title and entries', () => {
    const onClose = jest.fn();
    const { getByText } = render(
      <BatchImportResultModal
        visible
        title="批量导入角色卡"
        success={[
          { fileName: 'a.json', id: 1 },
          { fileName: 'b.json', id: 2 },
        ]}
        failed={[{ fileName: 'bad.png', error: 'no metadata' }]}
        onClose={onClose}
      />,
    );
    expect(getByText('批量导入角色卡')).toBeTruthy();
    expect(getByText(/a\.json/)).toBeTruthy();
    expect(getByText(/bad\.png/)).toBeTruthy();
    expect(getByText('no metadata')).toBeTruthy();
  });

  test('renders counts in summary', () => {
    const onClose = jest.fn();
    const { getByText } = render(
      <BatchImportResultModal
        visible
        title="t"
        success={[{ fileName: 'a', id: 1 }, { fileName: 'b', id: 2 }]}
        failed={[{ fileName: 'c', error: 'err' }]}
        onClose={onClose}
      />,
    );
    expect(getByText('✅ 成功 2')).toBeTruthy();
    expect(getByText('❌ 失败 1')).toBeTruthy();
  });

  test('calls onClose when close button pressed', () => {
    const onClose = jest.fn();
    const { getByText } = render(
      <BatchImportResultModal visible title="t" success={[]} failed={[]} onClose={onClose} />,
    );
    fireEvent.press(getByText('关闭'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('renders empty state gracefully', () => {
    const onClose = jest.fn();
    const { getByText } = render(
      <BatchImportResultModal visible title="空状态" success={[]} failed={[]} onClose={onClose} />,
    );
    expect(getByText('✅ 成功 0')).toBeTruthy();
    expect(getByText('❌ 失败 0')).toBeTruthy();
  });
});