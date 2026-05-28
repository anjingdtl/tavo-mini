/* eslint-env jest */

jest.mock('../src/services/database', () => ({
  createNote: jest.fn(async () => 42),
}));

import RNFS from 'react-native-fs';
import { keepLocalCopy, pick } from '@react-native-documents/picker';
import * as db from '../src/services/database';
import { importSelectedNoteText } from '../src/services/fileImport';

test('imports a TXT file as an editable global note and links it to the current project', async () => {
  (pick as jest.Mock).mockResolvedValue([{ uri: 'content://note', name: '设定备忘.txt' }]);
  (keepLocalCopy as jest.Mock).mockResolvedValue([{ status: 'success', localUri: 'file:///tmp/note.txt' }]);
  (RNFS.readFile as jest.Mock).mockResolvedValue('第一条设定\n第二条设定');

  await expect(importSelectedNoteText(7)).resolves.toBe(42);

  expect(db.createNote).toHaveBeenCalledWith(7, '设定备忘', '第一条设定\n第二条设定');
});
