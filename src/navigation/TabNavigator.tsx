import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, NativeStackScreenProps } from '@react-navigation/native-stack';
import { BookOpen, Boxes, FolderKanban, Settings } from 'lucide-react-native';
import { Text } from 'react-native';
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

export type EditorStackParamList = {
  EditorMain: undefined;
  ChapterEditor: { chapterId: number };
  ChapterSummary: { chapterId: number };
  PlotlineManager: undefined;
  StoryOverview: undefined;
  ContextConfig: undefined;
};

export type SettingsStackParamList = {
  SettingsMain: undefined;
  LLMSettings: undefined;
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
  </EditorStack.Navigator>
);

const SettingsStackScreen = () => (
  <SettingsStack.Navigator screenOptions={{ headerShown: false }}>
    <SettingsStack.Screen name="SettingsMain" component={SettingsScreen} />
    <SettingsStack.Screen name="LLMSettings" component={LLMSettingsScreen} />
  </SettingsStack.Navigator>
);

export const TabNavigator: React.FC = () => {
  const { theme } = useThemeStore();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          height: 62,
          paddingTop: 6,
          paddingBottom: 8,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '700' },
        tabBarIcon: ({ color, size }) => {
          const props = { color, size: size || 20 };
          if (route.name === 'Projects') return <FolderKanban {...props} />;
          if (route.name === 'Editor') return <BookOpen {...props} />;
          if (route.name === 'Resources') return <Boxes {...props} />;
          if (route.name === 'Settings') return <Settings {...props} />;
          return <Text />;
        },
      })}
    >
      <Tab.Screen name="Projects" component={ProjectStackScreen} options={{ tabBarLabel: '项目' }} />
      <Tab.Screen name="Editor" component={EditorStackScreen} options={{ tabBarLabel: '写作' }} />
      <Tab.Screen name="Resources" component={ResourceLibrary} options={{ tabBarLabel: '资料' }} />
      <Tab.Screen name="Settings" component={SettingsStackScreen} options={{ tabBarLabel: '设置' }} />
    </Tab.Navigator>
  );
};
