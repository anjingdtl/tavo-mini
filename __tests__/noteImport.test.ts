/* eslint-env jest */

jest.mock('../src/services/database', () => ({
  createNote: jest.fn(async () => 42),
  createNotesFromTextChunks: jest.fn(async () => ({ firstId: 42, createdCount: 1 })),
}));

import { keepLocalCopy, pick } from '@react-native-documents/picker';
import * as db from '../src/services/database';
import { readTextFileWithAutoEncoding } from '../src/services/textFileReader';
import { importSelectedNoteText } from '../src/services/fileImport';

jest.mock('../src/services/textFileReader', () => ({
  readTextFileWithAutoEncoding: jest.fn(),
}));

test('imports a TXT file as an editable global note and links it to the current project', async () => {
  (pick as jest.Mock).mockResolvedValue([{ uri: 'content://note', name: '设定备忘.txt' }]);
  (keepLocalCopy as jest.Mock).mockResolvedValue([{ status: 'success', localUri: 'file:///tmp/note.txt' }]);
  (readTextFileWithAutoEncoding as jest.Mock).mockResolvedValue('第一条设定\n第二条设定');

  await expect(importSelectedNoteText(7)).resolves.toEqual({ firstId: 42, createdCount: 1 });

  expect(db.createNotesFromTextChunks).toHaveBeenCalledWith(7, '设定备忘', '第一条设定\n第二条设定');
});

test('splits a large TXT file into multiple notes without losing text order', async () => {
  const largeText = `${'A'.repeat(120000)}\n${'B'.repeat(120000)}\n${'C'.repeat(120000)}`;
  (pick as jest.Mock).mockResolvedValue([{ uri: 'content://large-note', name: 'huge.txt' }]);
  (keepLocalCopy as jest.Mock).mockResolvedValue([{ status: 'success', localUri: 'file:///tmp/huge.txt' }]);
  (readTextFileWithAutoEncoding as jest.Mock).mockResolvedValue(largeText);
  (db.createNotesFromTextChunks as jest.Mock).mockResolvedValue({ firstId: 101, createdCount: 3 });

  await expect(importSelectedNoteText(7)).resolves.toEqual({ firstId: 101, createdCount: 3 });

  expect(db.createNotesFromTextChunks).toHaveBeenCalledWith(7, 'huge', largeText);
});
