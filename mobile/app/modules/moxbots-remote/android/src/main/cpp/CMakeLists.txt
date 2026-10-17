cmake_minimum_required(VERSION 3.22.1)
project(moxbots_mobile_jni LANGUAGES CXX)
add_library(mox_mobile_connection SHARED IMPORTED)
set_target_properties(mox_mobile_connection PROPERTIES IMPORTED_LOCATION
  "${CMAKE_CURRENT_LIST_DIR}/../../../native/${ANDROID_ABI}/libmox_mobile_connection.so"
  IMPORTED_NO_SONAME TRUE)
if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/../../../native/${ANDROID_ABI}/libmox_mobile_connection.so")
  message(FATAL_ERROR "Run node mobile/scripts/build-native.mjs android before the native app build")
endif()
add_library(moxbots_mobile_jni SHARED connection_jni.cpp)
target_include_directories(moxbots_mobile_jni PRIVATE
  "${CMAKE_CURRENT_LIST_DIR}/../../../../../../../connection/include")
target_link_libraries(moxbots_mobile_jni PRIVATE mox_mobile_connection)
target_link_options(moxbots_mobile_jni PRIVATE
  "-Wl,-z,max-page-size=16384" "-Wl,-z,common-page-size=16384")
