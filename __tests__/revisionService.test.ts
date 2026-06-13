/* eslint-env jest */

import type { ContentRevision } from '../src/types/revision';

// Mock database module
const mockCreateContentRevision = jest.fn();
const mockGetContentRevisions = jest.fn();
const mockGetLatestContentRevision = jest.fn();
const mockTrimContentRevisions = jest.fn();

jest.mock('../src/services/database', () => ({
  createContentRevision: mockCreateContentRevision,
  getContentRevisions: mockGetContentRevisions,
  getLatestContentRevision: mockGetLatestContentRevision,
  trimContentRevisions: mockTrimContentRevisions,
}));

describe('revisionService', () => {
  beforeEach(() => {
    jest.resetModules();
    mockCreateContentRevision.mockReset();
    mockGetContentRevisions.mockReset();
    mockGetLatestContentRevision.mockReset();
    mockTrimContentRevisions.mockReset();
    mockCreateContentRevision.mockResolvedValue(1);
    mockTrimContentRevisions.mockResolvedValue(undefined);
  });

  describe('createRevision', () => {
    test('skips duplicate adjacent revisions', async () => {
      const { createRevision } = require('../src/services/revisionService');
      mockGetLatestContentRevision.mockResolvedValue({
        id: 99,
        content: 'same content',
      });
      const id = await createRevision({
        projectId: 1,
        targetType: 'chapter',
        targetId: 10,
        title: 'Ch1',
        content: 'same content',
        source: 'before_clear',
      });
      expect(id).toBe(99);
      expect(mockCreateContentRevision).not.toHaveBeenCalled();
    });

    test('creates revision when content differs from latest', async () => {
      const { createRevision } = require('../src/services/revisionService');
      mockGetLatestContentRevision.mockResolvedValue({
        id: 99,
        content: 'old content',
      });
      mockCreateContentRevision.mockResolvedValue(100);
      const id = await createRevision({
        projectId: 1,
        targetType: 'chapter',
        targetId: 10,
        title: 'Ch1',
        content: 'new content',
        source: 'before_ai_replace',
      });
      expect(id).toBe(100);
      expect(mockCreateContentRevision).toHaveBeenCalledTimes(1);
    });

    test('creates revision when no previous revision exists', async () => {
      const { createRevision } = require('../src/services/revisionService');
      mockGetLatestContentRevision.mockResolvedValue(null);
      mockCreateContentRevision.mockResolvedValue(1);
      const id = await createRevision({
        projectId: 1,
        targetType: 'freeform',
        targetId: 5,
        title: 'Free',
        content: 'first revision',
        source: 'manual_checkpoint',
      });
      expect(id).toBe(1);
      expect(mockCreateContentRevision).toHaveBeenCalledTimes(1);
    });

    test('trims revisions after creating', async () => {
      const { createRevision } = require('../src/services/revisionService');
      mockGetLatestContentRevision.mockResolvedValue(null);
      mockCreateContentRevision.mockResolvedValue(1);
      await createRevision({
        projectId: 1,
        targetType: 'chapter',
        targetId: 10,
        title: 'Ch1',
        content: 'content',
        source: 'before_clear',
      });
      expect(mockTrimContentRevisions).toHaveBeenCalledWith('chapter', 10);
    });
  });

  describe('restoreRevision', () => {
    test('snapshots the current content (not the restore target) before restoring', async () => {
      const { restoreRevision } = require('../src/services/revisionService');
      mockGetLatestContentRevision.mockResolvedValue(null);
      mockCreateContentRevision.mockResolvedValue(200);

      const revision: ContentRevision = {
        id: 50,
        projectId: 1,
        targetType: 'chapter',
        targetId: 10,
        title: 'Ch1',
        content: 'restored content',
        source: 'manual_checkpoint',
        sourceRef: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      };

      const updateFn = jest.fn().mockResolvedValue(undefined);
      // getCurrentContent returns the live content currently in the editor,
      // which must be what gets snapshotted (not the restore target).
      const getCurrentContent = jest.fn().mockResolvedValue('current live content');
      await restoreRevision(revision, updateFn, getCurrentContent);

      expect(getCurrentContent).toHaveBeenCalled();
      expect(mockCreateContentRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'current live content',
          source: 'before_restore',
          sourceRef: 'restoring-from-50',
        }),
      );
      expect(updateFn).toHaveBeenCalledWith('restored content');
    });
  });

  describe('getRevisions', () => {
    test('returns revisions from database', async () => {
      const { getRevisions } = require('../src/services/revisionService');
      const mockRevisions = [
        { id: 1, content: 'rev1' },
        { id: 2, content: 'rev2' },
      ];
      mockGetContentRevisions.mockResolvedValue(mockRevisions);
      const result = await getRevisions('chapter', 10);
      expect(result).toEqual(mockRevisions);
      expect(mockGetContentRevisions).toHaveBeenCalledWith('chapter', 10);
    });
  });
});
