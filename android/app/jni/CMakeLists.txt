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

# NDK r27 defaults to a 4 KB linker page size. These flags make the app-owned
# shared library 16 KB ELF/RELRO compatible while remaining loadable on 4 KB
# devices. Prebuilt dependencies are pinned in app/build.gradle above.
target_link_options(appmodules PRIVATE
                    "-Wl,-z,max-page-size=16384"
                    "-Wl,-z,common-page-size=16384")
