import 'dart:io';

import 'package:flutter/services.dart';

/// Moving a finished file somewhere the phone can find it.
///
/// A transfer streams into the app's own storage, because that is the only
/// place it can write a file that grows, gets renamed and sometimes gets
/// deleted. Nothing else on the device can read that directory: from Android
/// 11 the system hides Android/data from file managers, and the gallery never
/// indexed it. So a transfer would finish, verify, and leave the person who
/// accepted it with no way to open what they had just received.
///
/// Once a file is complete and its checksum matches, it moves to the shared
/// Downloads collection. Only then — a half-written file in Downloads is worse
/// than one in a directory nobody browses.
class Downloads {
  static const _channel = MethodChannel('direct/downloads');

  /// Publish [file] as [name], optionally inside [subPath] beneath Downloads
  /// so a received folder keeps its shape.
  ///
  /// Returns where it landed, or null if the platform does not do this — iOS
  /// has no shared Downloads to move it to, and the app's own documents
  /// directory is already visible in Files there.
  static Future<String?> publish(
    File file, {
    required String name,
    String subPath = '',
  }) async {
    if (!Platform.isAndroid) return null;
    return _channel.invokeMethod<String>('publish', {
      'path': file.path,
      'name': name,
      'subPath': subPath,
    });
  }
}
