cmake_minimum_required(VERSION 3.22)
project(llamacpp_jni C CXX)

# ── Disable everything except CPU backend ──────────────────────────────
set(GGML_CUDA           OFF CACHE BOOL "" FORCE)
set(GGML_METAL          OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN         OFF CACHE BOOL "" FORCE)
set(GGML_OPENCL         OFF CACHE BOOL "" FORCE)
set(GGML_BLAS           OFF CACHE BOOL "" FORCE)
set(GGML_HIP            OFF CACHE BOOL "" FORCE)
set(GGML_SYCL           OFF CACHE BOOL "" FORCE)
set(GGML_RPC            OFF CACHE BOOL "" FORCE)
set(GGML_ACCELERATE     OFF CACHE BOOL "" FORCE)
set(GGML_OPENVINO       OFF CACHE BOOL "" FORCE)
set(GGML_MUSA           OFF CACHE BOOL "" FORCE)
set(GGML_ZDNN           OFF CACHE BOOL "" FORCE)
set(GGML_ZENDNN         OFF CACHE BOOL "" FORCE)
set(GGML_VIRTGPU        OFF CACHE BOOL "" FORCE)
set(GGML_WEBGPU         OFF CACHE BOOL "" FORCE)
set(GGML_HEXAGON        OFF CACHE BOOL "" FORCE)

# CPU-only, no OpenMP on Android
set(GGML_CPU            ON  CACHE BOOL "" FORCE)
set(GGML_OPENMP         OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE      OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE         OFF CACHE BOOL "" FORCE)

# Disable tests, examples, server, tools, common utils, curl
set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP      OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON   OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL        OFF CACHE BOOL "" FORCE)

# Shared libs for Android
set(BUILD_SHARED_LIBS    ON  CACHE BOOL "" FORCE)

# ARM64-specific: set ARM arch for NEON optimizations
set(GGML_CPU_ARM_ARCH    "armv8-a" CACHE STRING "" FORCE)

# ── Add llama.cpp as subdirectory ──────────────────────────────────────
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp llama.cpp-build)

# ── JNI bridge library ────────────────────────────────────────────────
add_library(llamacpp_jni SHARED llamacpp_jni.cpp)

target_include_directories(llamacpp_jni PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/include
)

target_link_libraries(llamacpp_jni
    llama
    log
    android
)
