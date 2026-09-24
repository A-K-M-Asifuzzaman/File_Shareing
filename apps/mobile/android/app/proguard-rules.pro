# WebRTC calls back into Java from native code by name, so R8 cannot see those
# references and will happily strip or rename the classes on the other end of
# them. The failure mode is a release build that connects and then dies on the
# first ICE callback, which is the worst kind to find late.
-keep class org.webrtc.** { *; }

# The foreground service is named as a string in AndroidManifest.xml and so is
# kept, but the plugin also reflects over its own callback entrypoints.
-keep class com.pravera.flutter_foreground_task.** { *; }
