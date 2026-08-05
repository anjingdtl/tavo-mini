import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  createNativeStackNavigator,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';
import {
  BookOpen,
  Boxes,
  FolderKanban,
  Hammer,
  Settings,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeStore } from '../store/themeStore';
import { useProjectStore } from '../store/projectStore';
import { ProjectListScreen } from '../screens/ProjectListScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { LLMSettingsScreen } from '../screens/LLMSettingsScreen';
import { ResourceLibrary } from '../screens/ResourceLibrary';
import { ContinuationHomeScreen } from '../screens/continuation/ContinuationHomeScreen';
import { ContinuationSourceChaptersScreen } from '../screens/continuation/ContinuationSourceChaptersScreen';
import { ContinuationSourceOrderingScreen } from '../screens/continuation/ContinuationSourceOrderingScreen';
import { ContinuationBoundaryScreen } from '../screens/continuation/ContinuationBoundaryScreen';
import { CanonAnalysisOverviewScreen } from '../screens/continuation/canon/CanonAnalysisOverviewScreen';
import { CanonCategoryListScreen } from '../screens/continuation/canon/CanonCategoryListScreen';
import { CanonAnalysisTasksScreen } from '../screens/continuation/canon/CanonAnalysisTasksScreen';
import { BuildScreen } from '../screens/BuildScreen';
import { OutlineEditor } from '../screens/OutlineEditor';
import { FreeformEditor } from '../screens/FreeformEditor';
import { ChapterEditor } from '../screens/ChapterEditor';
import { ChapterSummaryScreen } from '../screens/ChapterSummary';
import { PlotlineManager } from '../screens/PlotlineManager';
import { StoryOverview } from '../screens/StoryOverview';
import { ContextConfigScreen } from '../screens/ContextConfig';
import { PipelineConfigScreen } from '../screens/PipelineConfigScreen';
import { PipelineTaskScreen } from '../screens/PipelineTaskScreen';
import { PipelineResultScreen } from '../screens/PipelineResultScreen';
import { ContinuationResultScreen } from '../screens/continuation/ContinuationResultScreen';
import { ContinuationWorkspaceScreen } from '../screens/continuation/ContinuationWorkspaceScreen';
import { ContinuationStateReviewScreen } from '../screens/continuation/ContinuationStateReviewScreen';
import { RevisionHistoryScreen } from '../screens/RevisionHistoryScreen';
import { BackupCenterScreen } from '../screens/BackupCenterScreen';
import { RecallScreen } from '../screens/RecallScreen';
import { ContextPreviewScreen } from '../screens/ContextPreviewScreen';
import { DraftPreviewScreen } from '../screens/DraftPreviewScreen';
import { UsageStatsScreen } from '../screens/UsageStatsScreen';
import { VoiceSettingsScreen } from '../screens/VoiceSettingsScreen';
import { ContextAutoConfigScreen } from '../screens/ContextAutoConfigScreen';
import { StoryMemoryScreen } from '../screens/StoryMemoryScreen';
import { ContinuationGenerationConfigScreen } from '../screens/continuation/ContinuationGenerationConfigScreen';
import { StyleProfileDetailScreen } from '../screens/continuation/StyleProfileDetailScreen';

export type EditorStackParamList = {
  EditorMain: undefined;
  ChapterEditor: { chapterId: number };
  ChapterSummary: { chapterId: number };
  PlotlineManager: undefined;
  StoryOverview: undefined;
  StoryMemory: undefined;
  ContextConfig: undefined;
  PipelineResult: { taskId: string };
  ContinuationResult: { runId: string };
  RevisionHistory: {
    targetType: 'chapter' | 'freeform';
    targetId: number;
    projectId: number;
  };
  ContextPreview: { chapterId: number };
  DraftPreview: {
    targetType: 'chapter' | 'freeform';
    targetId: number;
    projectId: number;
  };
};

export type SettingsStackParamList = {
  SettingsMain: undefined;
  LLMSettings: undefined;
  VoiceSettings: undefined;
  PipelineConfig: undefined;
  PipelineTask: undefined;
  PipelineResult: { taskId: string };
  ContinuationResult: { runId: string };
  BackupCenter: undefined;
  Recall: undefined;
  UsageStats: undefined;
  ContextAutoConfig: undefined;
  ContinuationGenerationConfig: undefined;
};

/**
 * Resource stack (Spec §8.3, flattened). 资料 is a nested stack whose initial
 * route is ResourceLibrary — now a five-tab SegmentedControl (续写 plus the
 * original characters/worldbook/notes/presets). The old ResourceHome entry-list
 * layer was removed; 续写 is embedded directly inside ResourceLibrary. The
 * continuation sub-screens (Chapters / Boundary / Canon*) remain reachable via
 * navigation from the embedded 续写 body. ContinuationHome is retained as a
 * stack route for deep-link/standalone entry.
 */
export type ResourceStackParamList = {
  ContinuationHome: undefined;
  ContinuationSourceChapters: undefined;
  ContinuationSourceOrdering: {
    projectId: number;
    files: Array<{
      localPath: string;
      originalFileName: string;
      detectedEncoding: string;
      fileSizeBytes: number;
    }>;
  };
  ContinuationBoundary: undefined;
  ContinuationStateReview: undefined;
  CanonAnalysisOverview: undefined;
  CanonWorldRules: undefined;
  CanonCharacters: undefined;
  CanonRelationships: undefined;
  CanonPlotThreads: undefined;
  CanonExperiences: undefined;
  CanonAnalysisTasks: undefined;
  StyleProfileDetail: { profileId: string };
  ResourceLibrary: {
    initialTab?:
      | 'continuation'
      | 'outlines'
      | 'characters'
      | 'worldbook'
      | 'notes'
      | 'presets';
  };
};

const Tab = createBottomTabNavigator();
const ProjectStack = createNativeStackNavigator();
const EditorStack = createNativeStackNavigator<EditorStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();
const ResourceStack = createNativeStackNavigator<ResourceStackParamList>();

const ProjectStackScreen = () => (
  <ProjectStack.Navigator screenOptions={{ headerShown: false }}>
    <ProjectStack.Screen name="ProjectList" component={ProjectListScreen} />
  </ProjectStack.Navigator>
);

const EditorMainScreen = () => {
  const { currentProject } = useProjectStore();
  if (!currentProject) return <OutlineEditor />;
  if (currentProject.mode === 'continuation')
    return <ContinuationWorkspaceScreen />;
  return currentProject.mode === 'freeform' ? (
    <FreeformEditor />
  ) : (
    <OutlineEditor />
  );
};

const ChapterEditorRoute = ({
  route,
  navigation,
}: NativeStackScreenProps<EditorStackParamList, 'ChapterEditor'>) => (
  <ChapterEditor
    key={route.params.chapterId}
    chapterId={route.params.chapterId}
    onClose={() => navigation.goBack()}
  />
);

const ChapterSummaryRoute = ({
  route,
  navigation,
}: NativeStackScreenProps<EditorStackParamList, 'ChapterSummary'>) => (
  <ChapterSummaryScreen
    chapterId={route.params.chapterId}
    onClose={() => navigation.goBack()}
  />
);

const RevisionHistoryRoute = ({
  route,
  navigation,
}: NativeStackScreenProps<EditorStackParamList, 'RevisionHistory'>) => (
  <RevisionHistoryScreen
    targetType={route.params.targetType}
    targetId={route.params.targetId}
    projectId={route.params.projectId}
    onClose={() => navigation.goBack()}
  />
);

const ContextPreviewRoute = ({
  route,
  navigation,
}: NativeStackScreenProps<EditorStackParamList, 'ContextPreview'>) => (
  <ContextPreviewScreen
    chapterId={route.params.chapterId}
    onClose={() => navigation.goBack()}
    onNavigateOutlines={() => {
      // Jump to the Resources tab and open the 大纲 sub-tab directly so the
      // user can disable/shorten outlines after an outline-budget block.
      (navigation as any).navigate('Resources', {
        screen: 'ResourceLibrary',
        params: { initialTab: 'outlines' },
      });
    }}
  />
);

const DraftPreviewRoute = ({
  route,
  navigation,
}: NativeStackScreenProps<EditorStackParamList, 'DraftPreview'>) => (
  <DraftPreviewScreen
    targetType={route.params.targetType}
    targetId={route.params.targetId}
    projectId={route.params.projectId}
    onClose={() => navigation.goBack()}
  />
);

const ContinuationResultRoute = ({
  route,
  navigation,
}: NativeStackScreenProps<EditorStackParamList, 'ContinuationResult'>) => (
  <ContinuationResultScreen
    runId={route.params.runId}
    onClose={() => navigation.goBack()}
  />
);

const SettingsContinuationResultRoute = ({
  route,
  navigation,
}: NativeStackScreenProps<SettingsStackParamList, 'ContinuationResult'>) => (
  <ContinuationResultScreen
    runId={route.params.runId}
    onClose={() => navigation.goBack()}
  />
);

const StoryMemoryRoute = ({
  navigation,
}: NativeStackScreenProps<EditorStackParamList, 'StoryMemory'>) => (
  <StoryMemoryScreen onClose={() => navigation.goBack()} />
);

const EditorStackScreen = () => (
  <EditorStack.Navigator screenOptions={{ headerShown: false }}>
    <EditorStack.Screen name="EditorMain" component={EditorMainScreen} />
    <EditorStack.Screen name="ChapterEditor" component={ChapterEditorRoute} />
    <EditorStack.Screen name="ChapterSummary" component={ChapterSummaryRoute} />
    <EditorStack.Screen name="PlotlineManager" component={PlotlineManager} />
    <EditorStack.Screen name="StoryOverview" component={StoryOverview} />
    <EditorStack.Screen name="StoryMemory" component={StoryMemoryRoute} />
    <EditorStack.Screen name="ContextConfig" component={ContextConfigScreen} />
    <EditorStack.Screen
      name="PipelineResult"
      component={PipelineResultScreen}
    />
    <EditorStack.Screen
      name="ContinuationResult"
      component={ContinuationResultRoute}
    />
    <EditorStack.Screen
      name="RevisionHistory"
      component={RevisionHistoryRoute}
    />
    <EditorStack.Screen name="ContextPreview" component={ContextPreviewRoute} />
    <EditorStack.Screen name="DraftPreview" component={DraftPreviewRoute} />
  </EditorStack.Navigator>
);

const SettingsStackScreen = () => (
  <SettingsStack.Navigator screenOptions={{ headerShown: false }}>
    <SettingsStack.Screen name="SettingsMain" component={SettingsScreen} />
    <SettingsStack.Screen name="LLMSettings" component={LLMSettingsScreen} />
    <SettingsStack.Screen
      name="VoiceSettings"
      component={VoiceSettingsScreen}
    />
    <SettingsStack.Screen
      name="PipelineConfig"
      component={PipelineConfigScreen}
    />
    <SettingsStack.Screen name="PipelineTask" component={PipelineTaskScreen} />
    <SettingsStack.Screen
      name="PipelineResult"
      component={PipelineResultScreen}
    />
    <SettingsStack.Screen
      name="ContinuationResult"
      component={SettingsContinuationResultRoute}
    />
    <SettingsStack.Screen name="BackupCenter" component={BackupCenterScreen} />
    <SettingsStack.Screen name="Recall" component={RecallScreen} />
    <SettingsStack.Screen name="UsageStats" component={UsageStatsScreen} />
    <SettingsStack.Screen
      name="ContextAutoConfig"
      component={ContextAutoConfigScreen}
    />
    <SettingsStack.Screen
      name="ContinuationGenerationConfig"
      component={ContinuationGenerationConfigScreen}
    />
  </SettingsStack.Navigator>
);

const ResourceStackScreen = () => (
  <ResourceStack.Navigator
    screenOptions={{ headerShown: false }}
    initialRouteName="ResourceLibrary"
  >
    <ResourceStack.Screen name="ResourceLibrary" component={ResourceLibrary} />
    <ResourceStack.Screen
      name="ContinuationHome"
      component={ContinuationHomeScreen}
    />
    <ResourceStack.Screen
      name="ContinuationSourceChapters"
      component={ContinuationSourceChaptersScreen}
    />
    <ResourceStack.Screen
      name="ContinuationSourceOrdering"
      component={ContinuationSourceOrderingScreen}
    />
    <ResourceStack.Screen
      name="ContinuationBoundary"
      component={ContinuationBoundaryScreen}
    />
    <ResourceStack.Screen name="ContinuationStateReview">
      {({ navigation }) => (
        <ContinuationStateReviewScreen onClose={() => navigation.goBack()} />
      )}
    </ResourceStack.Screen>
    <ResourceStack.Screen
      name="CanonAnalysisOverview"
      component={CanonAnalysisOverviewScreen}
    />
    <ResourceStack.Screen
      name="StyleProfileDetail"
      component={StyleProfileDetailScreen}
    />
    <ResourceStack.Screen name="CanonWorldRules">
      {props => <CanonCategoryListScreen {...props} category="world" />}
    </ResourceStack.Screen>
    <ResourceStack.Screen name="CanonCharacters">
      {props => <CanonCategoryListScreen {...props} category="characters" />}
    </ResourceStack.Screen>
    <ResourceStack.Screen name="CanonRelationships">
      {props => <CanonCategoryListScreen {...props} category="relationships" />}
    </ResourceStack.Screen>
    <ResourceStack.Screen name="CanonPlotThreads">
      {props => <CanonCategoryListScreen {...props} category="plot" />}
    </ResourceStack.Screen>
    <ResourceStack.Screen name="CanonExperiences">
      {props => <CanonCategoryListScreen {...props} category="experiences" />}
    </ResourceStack.Screen>
    <ResourceStack.Screen
      name="CanonAnalysisTasks"
      component={CanonAnalysisTasksScreen}
    />
  </ResourceStack.Navigator>
);

export const TabNavigator: React.FC = () => {
  const { theme } = useThemeStore();
  const { workspaceMode } = useProjectStore();
  const insets = useSafeAreaInsets();
  const isContinuation = workspaceMode === 'continuation';
  const workflowArrowColor = { color: theme.colors.textMuted };

  const tabBarIcon = ({
    route,
    color,
    size,
  }: {
    route: any;
    color: string;
    size: number;
  }) => {
    const props = { color, size: size || 20 };
    if (route.name === 'Projects') return <FolderKanban {...props} />;
    if (route.name === 'Editor') return <BookOpen {...props} />;
    if (route.name === 'Build') return <Hammer {...props} />;
    if (route.name === 'Resources') return <Boxes {...props} />;
    if (route.name === 'Settings') return <Settings {...props} />;
    return <Text />;
  };

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          borderTopWidth: 1,
          height: 62 + insets.bottom,
          paddingTop: 6,
          paddingBottom: Math.max(8, insets.bottom),
          elevation: 0,
        },
        tabBarItemStyle: { paddingHorizontal: 2 },
        tabBarLabelStyle: {
          fontSize: 12,
          fontFamily: 'serif',
          fontWeight: '700',
          letterSpacing: 0.3,
        },
        tabBarBackground: () => (
          <View pointerEvents="none" style={styles.workflowArrows}>
            <Text
              style={[
                styles.workflowArrow,
                styles.workflowArrowOne,
                workflowArrowColor,
              ]}
            >
              →
            </Text>
            <Text
              style={[
                styles.workflowArrow,
                styles.workflowArrowTwo,
                workflowArrowColor,
              ]}
            >
              →
            </Text>
          </View>
        ),
        tabBarIcon: ({ color, size }) =>
          tabBarIcon({ route, color, size: size || 20 }),
      })}
    >
      <Tab.Screen
        name="Projects"
        component={ProjectStackScreen}
        options={{ tabBarLabel: '1 项目' }}
      />
      <Tab.Screen
        name="Resources"
        component={ResourceStackScreen}
        options={{ tabBarLabel: isContinuation ? '2 续写资料' : '2 资料' }}
      />
      <Tab.Screen
        name="Editor"
        component={EditorStackScreen}
        options={{ tabBarLabel: isContinuation ? '3 续写' : '3 写作' }}
      />
      <Tab.Screen
        name="Build"
        component={BuildScreen}
        options={{ tabBarLabel: '构建' }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsStackScreen}
        options={{ tabBarLabel: '设置' }}
      />
    </Tab.Navigator>
  );
};

const styles = StyleSheet.create({
  workflowArrows: {
    ...StyleSheet.absoluteFill,
  },
  workflowArrow: {
    position: 'absolute',
    top: 28,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 22,
  },
  workflowArrowOne: { left: '18.2%' },
  workflowArrowTwo: { left: '38.2%' },
});
