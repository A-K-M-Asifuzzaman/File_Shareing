import 'package:direct_protocol/direct_protocol.dart';
import 'package:flutter/material.dart';

import 'store.dart';
import 'theme.dart';

/// What this device has sent and received.
///
/// It exists because the product deliberately keeps no record anywhere else:
/// once a transfer ends there is no dashboard to check, so without this there
/// is no way to answer "did that 40 GB actually go through".
class HistoryPage extends StatelessWidget {
  const HistoryPage({super.key});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'Recent transfers',
          style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
        ),
        actions: [
          ValueListenableBuilder<List<HistoryItem>>(
            valueListenable: Store.instance.history,
            builder: (context, items, _) => items.isEmpty
                ? const SizedBox.shrink()
                : TextButton(
                    onPressed: Store.instance.clearHistory,
                    child: const Text('Clear'),
                  ),
          ),
        ],
      ),
      body: ValueListenableBuilder<List<HistoryItem>>(
        valueListenable: Store.instance.history,
        builder: (context, items, _) {
          if (items.isEmpty) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Text(
                  'Nothing yet. Transfers you send and receive are listed '
                  'here — on this device only, and never the links.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 14, height: 1.6, color: p.inkSoft),
                ),
              ),
            );
          }

          return ListView.separated(
            padding: const EdgeInsets.symmetric(vertical: 8),
            itemCount: items.length,
            separatorBuilder: (_, _) => Divider(height: 1, color: p.line),
            itemBuilder: (context, i) => _Row(item: items[i]),
          );
        },
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final HistoryItem item;
  const _Row({required this.item});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final tone = switch (item.outcome) {
      'complete' => p.signal,
      'declined' => p.inkFaint,
      _ => p.danger,
    };

    return ListTile(
      leading: Icon(
        item.sent ? Icons.arrow_upward : Icons.arrow_downward,
        size: 18,
        color: p.inkFaint,
      ),
      title: Text.rich(
        TextSpan(
          text: item.label,
          children: [
            if (item.fileCount > 1)
              TextSpan(
                text: ' and ${item.fileCount - 1} more',
                style: TextStyle(color: p.inkFaint),
              ),
          ],
        ),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 14),
      ),
      subtitle: Text(
        '${formatBytes(item.bytes)}'
        '${item.seconds != null ? ' · ${formatDuration(item.seconds!)}' : ''}'
        ' · ${_when(item.at)}',
        style: tabular.copyWith(fontSize: 11, color: p.inkFaint),
      ),
      trailing: Text(
        item.outcome == 'complete' ? 'verified' : item.outcome,
        style: TextStyle(fontSize: 12, color: tone),
      ),
    );
  }
}

/// Relative where it helps, absolute once "3 days ago" stops meaning anything.
String _when(int at) {
  final seconds =
      (DateTime.now().millisecondsSinceEpoch - at) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return '${seconds ~/ 60}m ago';
  if (seconds < 86400) return '${seconds ~/ 3600}h ago';
  if (seconds < 604800) return '${seconds ~/ 86400}d ago';
  final d = DateTime.fromMillisecondsSinceEpoch(at);
  return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}
