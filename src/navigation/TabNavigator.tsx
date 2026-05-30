import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, NativeStackScreenProps } from '@react-navigation/native-stack';
import { BookOpen, Boxes, FolderKanban, Settings } from 'lucide-react-native';
import { Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeStore } from '../store/themeStore';
import { useProjectStore } from '../store/projectStore';
import { ProjectListScreen } from '../screens/ProjectListScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { LLMSettingsScreen } from '../screens/LLMSettingsScreen';
import { ResourceLibrary } from '../screens/ResourceLibrary';
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

export type EditorStackParamList = {
  EditorMain: undefined;
  ChapterEditor: { chapterId: number };
  ChapterSummary: { chapterId: number };
  PlotlineManager: undefined;
  StoryOverview: undefined;
  ContextConfig: undefined;
  PipelineResult: { taskId: string };
};

export type SettingsStackParamList = {
  SettingsMain: undefined;
  LLMSettings: undefined;
  PipelineConfig: undefined;
  PipelineTask: undefined;
  PipelineResult: { taskId: string };
};

const Tab = createBottomTabNavigator();
const ProjectStack = createNativeStackNavigator();
const EditorStack = createNativeStackNavigator<EditorStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();

const ProjectStackScreen = () => (
  <ProjectStack.Navigator screenOptions={{ headerShown: false }}>
    <ProjectStack.Screen name="ProjectList" component={ProjectListScreen} />
  </ProjectStack.Navigator>
);

const EditorMainScreen = () => {
  const { currentProject } = useProjectStore();
  if (!currentProject) return <OutlineEditor />;
  return currentProject.mode === 'freeform' ? <FreeformEditor /> : <OutlineEditor />;
};

const ChapterEditorRoute = ({ route, navigation }: NativeStackScreenProps<EditorStackParamList, 'ChapterEditor'>) => (
  <ChapterEditor chapterId={route.params.chapterId} onClose={() => navigation.goBack()} />
);

const ChapterSummaryRoute = ({ route, navigation }: NativeStackScreenProps<EditorStackParamList, 'ChapterSummary'>) => (
  <ChapterSummaryScreen chapterId={route.params.chapterId} onClose={() => navigation.goBack()} />
);

const EditorStackScreen = () => (
  <EditorStack.Navigator screenOptions={{ headerShown: false }}>
    <EditorStack.Screen name="EditorMain" component={EditorMainScreen} />
    <EditorStack.Screen name="ChapterEditor" component={ChapterEditorRoute} />
    <EditorStack.Screen name="ChapterSummary" component={ChapterSummaryRoute} />
    <EditorStack.Screen name="PlotlineManager" component={PlotlineManager} />
    <EditorStack.Screen name="StoryOverview" component={StoryOverview} />
    <EditorStack.Screen name="ContextConfig" component={ContextConfigScreen} />
    <EditorStack.Screen name="PipelineResult" component={PipelineResultScreen} />
  </EditorStack.Navigator>
);

const SettingsStackScreen = () => (
  <SettingsStack.Navigator screenOptions={{ headerShown: false }}>
    <SettingsStack.Screen name="SettingsMain" component={SettingsScreen} />
    <SettingsStack.Screen name="LLMSettings" component={LLMSettingsScreen} />
    <SettingsStack.Screen name="PipelineConfig" component={PipelineConfigScreen} />
    <SettingsStack.Screen name="PipelineTask" component={PipelineTaskScreen} />
    <SettingsStack.Screen name="PipelineResult" component={PipelineResultScreen} />
  </SettingsStack.Navigator>
);

export const TabNavigator: React.FC = () => {
  const { theme } = useThemeStore();
  const insets = useSafeAreaInsets();

  const tabBarIcon = ({ route, color, size }: { route: any; color: string; size: number }) => {
    const props = { color, size: size || 20 };
    if (route.name === 'Projects') return <FolderKanban {...props} />;
    if (route.name === 'Editor') return <BookOpen {...props} />;
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
          height: 62 + insets.bottom,
          paddingTop: 6,
          paddingBottom: Math.max(8, insets.bottom),
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '700' },
        tabBarIcon: ({ color, size }) => tabBarIcon({ route, color, size: size || 20 }),
      })}
    >
      <Tab.Screen name="Projects" component={ProjectStackScreen} options={{ tabBarLabel: '项目' }} />
      <Tab.Screen name="Editor" component={EditorStackScreen} options={{ tabBarLabel: '写作' }} />
      <Tab.Screen name="Resources" component={ResourceLibrary} options={{ tabBarLabel: '资料' }} />
      <Tab.Screen name="Settings" component={SettingsStackScreen} options={{ tabBarLabel: '设置' }} />
    </Tab.Navigator>
  );
};
