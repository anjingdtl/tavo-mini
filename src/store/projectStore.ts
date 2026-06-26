import { create } from 'zustand';
import * as db from '../services/database';
import type { Project, ProjectMode } from '../types/novel';

interface ProjectState {
  projects: Project[];
  currentProject: Project | null;
  loading: boolean;
  loadProjects: () => Promise<void>;
  createProject: (name: string, mode: ProjectMode) => Promise<number>;
  deleteProject: (id: number) => Promise<void>;
  renameProject: (id: number, name: string) => Promise<void>;
  setCurrentProject: (project: Project | null) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProject: null,
  loading: false,

  loadProjects: async () => {
    set({ loading: true });
    try {
      const projects = await db.getAllProjects();
      const selectedId = await db.getSetting('current_project_id');
      const current = selectedId
        ? projects.find((project) => project.id === Number(selectedId)) || null
        : get().currentProject;
      // 8.13 修复：current 不在 projects 时回退 projects[0] 但不同步 DB，每次启动都走回退
      const fallback = projects[0] || null;
      const resolved = current && projects.some((project) => project.id === current.id) ? current : fallback;
      if (resolved && (!current || !projects.some((p) => p.id === current.id))) {
        // 回退时同步写 DB，避免下次启动重复走回退分支
        await db.setSetting('current_project_id', String(resolved.id));
      }
      set({ projects, currentProject: resolved });
    } catch (error) {
      // 8.12 修复：loadProjects 仅 try-finally 无 catch，抛错时 unhandled rejection
      console.warn('[projectStore] loadProjects failed:', error);
    } finally {
      set({ loading: false });
    }
  },

  createProject: async (name, mode) => {
    const id = await db.createProject(name, mode);
    const project = await db.getProjectById(id);
    if (project) await get().setCurrentProject(project);
    await get().loadProjects();
    return id;
  },

  deleteProject: async (id) => {
    await db.deleteProject(id);
    if (get().currentProject?.id === id) {
      await db.setSetting('current_project_id', '');
      set({ currentProject: null });
    }
    await get().loadProjects();
  },

  renameProject: async (id, name) => {
    await db.updateProject(id, name);
    await get().loadProjects();
  },

  setCurrentProject: async (project) => {
    set({ currentProject: project });
    await db.setSetting('current_project_id', project ? String(project.id) : '');
  },
}));
