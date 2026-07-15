/* eslint-env jest */

const mockGetAllProjects = jest.fn();
const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();
const mockCreateProject = jest.fn();
const mockGetProjectById = jest.fn();
const mockDeleteProject = jest.fn();
const mockUpdateProject = jest.fn();
const mockGetBackgroundPipelineEnabled = jest.fn();
const mockGetLLMConfigs = jest.fn();
const mockGetContextConfig = jest.fn();
const mockGetLocalModelById = jest.fn();
const mockSetLLMConfig = jest.fn();
const mockSaveLLMConfig = jest.fn();
const mockSetActiveLLMConfig = jest.fn();
const mockDeleteLLMConfig = jest.fn();
const mockSetContextConfig = jest.fn();
const mockSetBackgroundPipelineEnabled = jest.fn();

jest.mock('../src/services/database', () => ({
  getAllProjects: (...args: any[]) => mockGetAllProjects(...args),
  getSetting: (...args: any[]) => mockGetSetting(...args),
  setSetting: (...args: any[]) => mockSetSetting(...args),
  createProject: (...args: any[]) => mockCreateProject(...args),
  getProjectById: (...args: any[]) => mockGetProjectById(...args),
  deleteProject: (...args: any[]) => mockDeleteProject(...args),
  updateProject: (...args: any[]) => mockUpdateProject(...args),
  getBackgroundPipelineEnabled: (...args: any[]) => mockGetBackgroundPipelineEnabled(...args),
  getLLMConfigs: (...args: any[]) => mockGetLLMConfigs(...args),
  getContextConfig: (...args: any[]) => mockGetContextConfig(...args),
  getLocalModelById: (...args: any[]) => mockGetLocalModelById(...args),
  setLLMConfig: (...args: any[]) => mockSetLLMConfig(...args),
  saveLLMConfig: (...args: any[]) => mockSaveLLMConfig(...args),
  setActiveLLMConfig: (...args: any[]) => mockSetActiveLLMConfig(...args),
  deleteLLMConfig: (...args: any[]) => mockDeleteLLMConfig(...args),
  setContextConfig: (...args: any[]) => mockSetContextConfig(...args),
  setBackgroundPipelineEnabled: (...args: any[]) => mockSetBackgroundPipelineEnabled(...args),
}));

import { useProjectStore } from '../src/store/projectStore';
import { useSettingsStore } from '../src/store/settingsStore';
import { PipelineForeground } from '../src/native/PipelineForegroundModule';

const projectOne = { id: 1, name: '项目一', mode: 'outline', created_at: '', updated_at: '' } as any;
const projectTwo = { id: 2, name: '项目二', mode: 'freeform', created_at: '', updated_at: '' } as any;
const onlineConfig = {
  id: 1,
  name: '在线',
  provider_type: 'openai_compatible',
  base_url: 'https://example.com',
  api_key: '',
  model_name: 'model',
  is_active: 1,
  local_model_id: null,
  local_backend: null,
  context_window: 4096,
  max_output_tokens: 4000,
} as any;

describe('project and settings stores', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    useProjectStore.setState({ projects: [], currentProject: null, loading: false });
    useSettingsStore.setState({
      llmConfig: onlineConfig,
      llmConfigs: [onlineConfig],
      contextConfig: {} as any,
      backgroundPipelineEnabled: true,
    });
    mockGetSetting.mockResolvedValue(null);
    mockSetSetting.mockResolvedValue(undefined);
    mockGetAllProjects.mockResolvedValue([projectOne, projectTwo]);
    mockGetProjectById.mockResolvedValue(projectOne);
    mockCreateProject.mockResolvedValue(2);
    mockDeleteProject.mockResolvedValue(undefined);
    mockUpdateProject.mockResolvedValue(undefined);
    mockGetBackgroundPipelineEnabled.mockResolvedValue(true);
    mockGetLLMConfigs.mockResolvedValue([onlineConfig]);
    mockGetContextConfig.mockResolvedValue({ strategy: 'sliding' });
    mockGetLocalModelById.mockResolvedValue({ status: 'ready' });
    mockSetLLMConfig.mockResolvedValue(undefined);
    mockSaveLLMConfig.mockResolvedValue(2);
    mockSetActiveLLMConfig.mockResolvedValue(undefined);
    mockDeleteLLMConfig.mockResolvedValue(undefined);
    mockSetContextConfig.mockResolvedValue(undefined);
    mockSetBackgroundPipelineEnabled.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('loads, selects, creates, renames, deletes, and recovers project state', async () => {
    await useProjectStore.getState().loadProjects();
    expect(useProjectStore.getState().currentProject).toEqual(projectOne);
    expect(useProjectStore.getState().loading).toBe(false);

    mockGetSetting.mockResolvedValueOnce('2');
    await useProjectStore.getState().loadProjects();
    expect(useProjectStore.getState().currentProject).toEqual(projectTwo);

    mockGetSetting.mockResolvedValueOnce('999');
    await useProjectStore.getState().loadProjects();
    expect(mockSetSetting).toHaveBeenCalledWith('current_project_id', '1');

    mockGetProjectById.mockResolvedValueOnce(projectTwo);
    mockGetAllProjects.mockResolvedValueOnce([projectTwo]);
    await expect(useProjectStore.getState().createProject('项目二', 'freeform')).resolves.toBe(2);
    expect(useProjectStore.getState().currentProject).toEqual(projectTwo);

    useProjectStore.setState({ projects: [projectOne], currentProject: projectOne });
    await useProjectStore.getState().renameProject(1, '改名');
    await useProjectStore.getState().deleteProject(1);
    expect(mockUpdateProject).toHaveBeenCalledWith(1, '改名');
    expect(mockDeleteProject).toHaveBeenCalledWith(1);
    expect(mockSetSetting).toHaveBeenCalledWith('current_project_id', '');

    await useProjectStore.getState().setCurrentProject(null);
    expect(useProjectStore.getState().currentProject).toBeNull();

    mockGetAllProjects.mockRejectedValueOnce(new Error('数据库不可用'));
    await useProjectStore.getState().loadProjects();
    expect(useProjectStore.getState().loading).toBe(false);
  });

  test('loads usable LLM configuration, self-heals inactive state, and updates settings', async () => {
    const localConfig = { ...onlineConfig, id: 2, provider_type: 'llama_cpp', local_model_id: 'local-1', is_active: 1 };
    mockGetLLMConfigs
      .mockResolvedValueOnce([{ ...onlineConfig, is_active: 0 }, localConfig])
      .mockResolvedValueOnce([{ ...onlineConfig, is_active: 1 }, { ...localConfig, is_active: 0 }]);
    mockGetLocalModelById.mockResolvedValueOnce({ status: 'missing' });
    const bridgeSpy = jest.spyOn(PipelineForeground, 'setEnabled');

    await useSettingsStore.getState().loadSettings();
    expect(mockSetActiveLLMConfig).toHaveBeenCalledWith(1);
    expect(useSettingsStore.getState().llmConfig.id).toBe(1);
    expect(bridgeSpy).toHaveBeenCalledWith(true);

    await useSettingsStore.getState().setLLMConfig('https://new.example', 'key', 'new-model');
    await expect(useSettingsStore.getState().saveLLMConfig({ name: '保存' })).resolves.toBe(2);
    await useSettingsStore.getState().setActiveLLMConfig(1);
    await useSettingsStore.getState().deleteLLMConfig(1);
    await useSettingsStore.getState().setContextConfig({ strategy: 'full' } as any);
    await useSettingsStore.getState().setBackgroundPipelineEnabled(false);
    expect(mockSetContextConfig).toHaveBeenCalled();
    expect(mockSetBackgroundPipelineEnabled).toHaveBeenCalledWith(false);
    expect(PipelineForeground.setEnabled).toHaveBeenLastCalledWith(false);
  });

  test('keeps background bridge alive when unrelated settings fail', async () => {
    mockGetBackgroundPipelineEnabled.mockRejectedValueOnce(new Error('开关读取失败'));
    mockGetLLMConfigs.mockRejectedValueOnce(new Error('LLM 读取失败'));
    const bridgeSpy = jest.spyOn(PipelineForeground, 'setEnabled');
    await useSettingsStore.getState().loadSettings();
    expect(bridgeSpy).toHaveBeenCalledWith(true);
  });
});
