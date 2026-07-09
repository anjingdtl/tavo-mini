cmake_minimum_required(VERSION 3.22.1)

# Root project MUST be named `appmodules` (not `llamacpp_jni`).
# Reason: react-native's default-app-setup/CMakeLists.txt includes
# `ReactNative-application.cmake`, which calls
#     add_library(${CMAKE_PROJECT_NAME} SHARED ${default-app-setup-cpp})
# i.e. it expects the top-level project name to be `appmodules` and
# builds the shared library that registers
# `DefaultTurboModuleManagerDelegate::javaModuleProvider` via OnLoad.cpp.
project(appmodules CXX)

# llama.cpp JNI lives in a subdir so its own `project(llamacpp_jni)`
# doesn't conflict with the top-level `appmodules` target name.
add_subdirectory(llama_jni)

# React Native appmodules (OnLoad.cpp + autolinking cpp). This restores
# the javaModuleProvider pointer that JS-side
# `TurboModuleRegistry.getEnforcing('PlatformConstants')` etc. depend on.
add_subdirectory(${REACT_ANDROID_DIR}/cmake-utils/default-app-setup
                 ${CMAKE_CURRENT_BINARY_DIR}/default-app-setup-build)
