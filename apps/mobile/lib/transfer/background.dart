import 'package:flutter_foreground_task/flutter_foreground_task.dart';

/// Keeps a transfer running while the app is in the background.
///
/// This is the whole reason a native client exists. A browser tab is frozen
/// the moment you leave it and no web API exempts a WebRTC transfer from
/// that; an Android foreground service is not frozen, so the transfer keeps
/// going with a notification showing progress.
///
/// Two Android details worth knowing:
///
///  * The service type must be `dataSync`, and on Android 14+ the matching
///    permission must be declared, or the service is refused at start.
///  * On Android 15+ `dataSync` services are capped at six hours in any
///    24-hour window, after which the system stops them. A 100 GB transfer
///    over a slow link can reach that, and the user has to foreground the app
///    to reset it. We surface progress in the notification so at least it is
///    obvious what is still running.
class TransferService {
  static bool _initialised = false;

  static void init() {
    if (_initialised) return;
    _initialised = true;

    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'direct_transfer',
        channelName: 'File transfers',
        channelDescription: 'Shown while a transfer is running.',
        channelImportance: NotificationChannelImportance.LOW,
        priority: NotificationPriority.LOW,
      ),
      iosNotificationOptions: const IOSNotificationOptions(
        showNotification: false,
        playSound: false,
      ),
      foregroundTaskOptions: ForegroundTaskOptions(
        eventAction: ForegroundTaskEventAction.nothing(),
        autoRunOnBoot: false,
        allowWakeLock: true,
        allowWifiLock: true,
      ),
    );
  }

  /// Ask for what the service needs. Notifications are a runtime permission
  /// from Android 13, and without it the service runs but shows nothing.
  static Future<void> requestPermissions() async {
    if (await FlutterForegroundTask.checkNotificationPermission() !=
        NotificationPermission.granted) {
      await FlutterForegroundTask.requestNotificationPermission();
    }
  }

  static Future<void> start({
    required String title,
    required String body,
  }) async {
    init();
    if (await FlutterForegroundTask.isRunningService) {
      return update(title: title, body: body);
    }
    await FlutterForegroundTask.startService(
      notificationTitle: title,
      notificationText: body,
    );
  }

  static Future<void> update({
    required String title,
    required String body,
  }) async {
    if (!await FlutterForegroundTask.isRunningService) return;
    await FlutterForegroundTask.updateService(
      notificationTitle: title,
      notificationText: body,
    );
  }

  static Future<void> stop() async {
    if (await FlutterForegroundTask.isRunningService) {
      await FlutterForegroundTask.stopService();
    }
  }
}
