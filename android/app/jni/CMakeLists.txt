cmake_minimum_required(VERSION 3.22.1)

# Root project MUST be named `appmodules` (not `llamacpp_jni`).
# Reason: react-native's default-app-setup/CMakeLists.txt includes
# `ReactNative-application.cmake`, which calls
#     add_library(${CMAKE_PROJECT_NAME} SHARED ${default-app-setup-cpp})
# i.e. it expects the top-level project name to be `appmodules` and
# builds the shared library that registers
# `DefaultTurboModuleManagerDelegate::javaModuleProvider` via OnLoad.cpp.
project(appmodules CXX)

# React Native appmodules (OnLoad.cpp + autolinking cpp + app codegen).
# The default setup includes ReactNative-application.cmake, which links
# generated app-level providers such as ShineWriterSpec_ModuleProvider when
# `android/app/build/generated/source/codegen/jni/CMakeLists.txt` exists.
# This restores the javaModuleProvider pointer that JS-side
# `TurboModuleRegistry.getEnforcing('PlatformConstants')` depends on.
add_subdirectory(${REACT_ANDROID_DIR}/cmake-utils/default-app-setup
                 ${CMAKE_CURRENT_BINARY_DIR}/default-app-setup-build)
