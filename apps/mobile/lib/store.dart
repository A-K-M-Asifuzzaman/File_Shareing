import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import 'theme.dart';

/// Small local state: the theme choices, and a record of past transfers.
///
/// One JSON file in the app's own directory rather than a preferences plugin.
/// There is very little to remember and none of it is worth a platform
/// channel, and `path_provider` is already here for deciding where received
/// files go.
///
/// The history is deliberately only a record — names, sizes and outcomes,
/// never a link, which would be a live capability sitting on disk, and never
/// any bytes. It never leaves the device, which is the point of the product.
class HistoryItem {
  final int at;
  final bool sent;
  final String label;
  final int fileCount;
  final int bytes;

  /// 'complete', 'failed' or 'declined'.
  final String outcome;
  final double? seconds;

  const HistoryItem({
    required this.at,
    required this.sent,
    required this.label,
    required this.fileCount,
    required this.bytes,
    required this.outcome,
    this.seconds,
  });

  Map<String, dynamic> toJson() => {
    'at': at,
    'sent': sent,
    'label': label,
    'fileCount': fileCount,
    'bytes': bytes,
    'outcome': outcome,
    if (seconds != null) 'seconds': seconds,
  };

  static HistoryItem? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final at = raw['at'];
    if (at is! int) return null;
    return HistoryItem(
      at: at,
      sent: raw['sent'] == true,
      label: raw['label']?.toString() ?? 'transfer',
      fileCount: raw['fileCount'] is int ? raw['fileCount'] as int : 1,
      bytes: raw['bytes'] is int ? raw['bytes'] as int : 0,
      outcome: raw['outcome']?.toString() ?? 'complete',
      seconds: (raw['seconds'] as num?)?.toDouble(),
    );
  }
}

class Store {
  static const _limit = 40;
  static final Store instance = Store._();
  Store._();

  /// Rebuild the app when any of these change.
  final ValueNotifier<ThemeMode> themeMode = ValueNotifier(ThemeMode.system);
  final ValueNotifier<Accent> accent = ValueNotifier(Accent.signal);
  final ValueNotifier<List<HistoryItem>> history = ValueNotifier(const []);

  /// One handle for "anything about the look changed", so MaterialApp can
  /// listen once instead of nesting a builder per axis.
  late final Listenable look = Listenable.merge([themeMode, accent]);

  File? _file;

  /// Read what was saved. Failure is not worth surfacing: the app works
  /// without it, it just starts on the system theme with an empty list.
  Future<void> load() async {
    try {
      final dir = await getApplicationSupportDirectory();
      final file = File('${dir.path}/direct-state.json');
      _file = file;
      if (!await file.exists()) return;

      final raw = jsonDecode(await file.readAsString());
      if (raw is! Map) return;

      themeMode.value = switch (raw['theme']) {
        'light' => ThemeMode.light,
        'dark' => ThemeMode.dark,
        _ => ThemeMode.system,
      };
      // Unknown or missing falls back to the default rather than throwing:
      // junk in storage must not stop the app starting.
      accent.value = Accent.byName(raw['accent'] as String?);
      final items = (raw['history'] as List? ?? [])
          .map(HistoryItem.fromJson)
          .whereType<HistoryItem>()
          .take(_limit)
          .toList();
      history.value = List.unmodifiable(items);
    } catch (_) {
      /* start fresh */
    }
  }

  void setTheme(ThemeMode mode) {
    themeMode.value = mode;
    unawaited(_save());
  }

  void setAccent(Accent value) {
    accent.value = value;
    unawaited(_save());
  }

  void record(HistoryItem item) {
    history.value = List.unmodifiable([
      item,
      ...history.value,
    ].take(_limit).toList());
    unawaited(_save());
  }

  void clearHistory() {
    history.value = const [];
    unawaited(_save());
  }

  Future<void> _save() async {
    final file = _file;
    if (file == null) return;
    try {
      await file.writeAsString(
        jsonEncode({
          'theme': switch (themeMode.value) {
            ThemeMode.light => 'light',
            ThemeMode.dark => 'dark',
            ThemeMode.system => 'system',
          },
          'accent': accent.value.name,
          'history': history.value.map((h) => h.toJson()).toList(),
        }),
      );
    } catch (_) {
      /* a failed save must never take a transfer down with it */
    }
  }
}
