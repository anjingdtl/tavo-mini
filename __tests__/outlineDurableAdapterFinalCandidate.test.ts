import { createOutlineDurableAdapter } from '../src/services/writing/persistence/outlineDurableAdapter';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';

describe('outline durable adapter final candidate', () => {
  const taskId = 'outline-final-candidate-task';

  beforeEach(() => {
    usePipelineTaskStore.setState({
      tasks: [
        {
          id: taskId,
          stageResults: [
            { stage: 'draft', status: 'success', text: 'DRAFT-BODY' },
            { stage: 'brief', status: 'success', text: 'REPAIRED-BODY' },
            { stage: 'proof', status: 'success', text: 'PROOF-BODY' },
          ],
        } as any,
      ],
    });
  });

  afterEach(() => {
    usePipelineTaskStore.setState({ tasks: [] });
  });

  test.each(['finalValidate', 'persist'] as const)(
    '%s preloads the current Revision/brief candidate before proof or draft',
    async stage => {
      const adapter = createOutlineDurableAdapter({
        taskId,
        chapter: {} as any,
      });

      await expect(adapter.loadExisting!(stage)).resolves.toMatchObject({
        stage,
        body: 'REPAIRED-BODY',
      });
    },
  );
});
