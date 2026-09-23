import 'dart:async';

import 'package:direct_protocol/direct_protocol.dart';
import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import 'theme.dart';

/// Two endpoints and the path between them, the same motif as the web client.
class Endpoints extends StatefulWidget {
  final bool live;
  final bool done;
  final bool error;
  final String from;
  final String to;

  const Endpoints({
    super.key,
    this.live = false,
    this.done = false,
    this.error = false,
    this.from = 'You',
    this.to = 'Them',
  });

  @override
  State<Endpoints> createState() => _EndpointsState();
}

class _EndpointsState extends State<Endpoints>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final caption = TextStyle(
      fontSize: 11,
      color: p.inkFaint,
      letterSpacing: 1,
    );

    return Column(
      children: [
        SizedBox(
          height: 44,
          child: AnimatedBuilder(
            animation: _c,
            builder: (_, _) => CustomPaint(
              painter: _EndpointsPainter(
                t: _c.value,
                live: widget.live,
                done: widget.done,
                error: widget.error,
                palette: p,
              ),
              size: const Size(double.infinity, 44),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(widget.from.toUpperCase(), style: caption),
            Text(widget.to.toUpperCase(), style: caption),
          ],
        ),
      ],
    );
  }
}

class _EndpointsPainter extends CustomPainter {
  final double t;
  final bool live, done, error;
  final Palette palette;

  _EndpointsPainter({
    required this.t,
    required this.live,
    required this.done,
    required this.error,
    required this.palette,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final y = size.height / 2;
    final left = Offset(10, y);
    final right = Offset(size.width - 10, y);

    final pathColor = error
        ? palette.danger
        : (live || done)
        ? palette.signal
        : palette.lineStrong;

    final track = Paint()
      ..color = pathColor.withValues(alpha: done ? 1 : 0.35)
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(left.translate(14, 0), right.translate(-14, 0), track);

    // Packets moving left to right while the transfer is live.
    if (live) {
      final dot = Paint()..color = palette.signal;
      final span = (right.dx - 14) - (left.dx + 14);
      for (var i = 0; i < 4; i++) {
        final p = ((t + i / 4) % 1.0);
        canvas.drawCircle(Offset(left.dx + 14 + span * p, y), 3, dot);
      }
    }

    canvas.drawCircle(left, 7, Paint()..color = palette.ink);

    if (done || live) {
      canvas.drawCircle(right, 7, Paint()..color = palette.signal);
    } else {
      canvas.drawCircle(
        right,
        7,
        Paint()
          ..color = palette.inkFaint
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2,
      );
    }
  }

  @override
  bool shouldRepaint(_EndpointsPainter old) =>
      old.t != t ||
      old.live != live ||
      old.done != done ||
      old.error != error ||
      old.palette != palette;
}

/// Throughput over the last half-minute.
///
/// A single rate number cannot tell a steady 40 MB/s from one sawtoothing
/// between 5 and 80, and on a long transfer that difference is what says
/// whether the network is the problem. Scaled to its own peak, so it reads as
/// shape rather than as a worse copy of the number above it.
class Sparkline extends StatelessWidget {
  final List<double> values;
  const Sparkline({super.key, required this.values});

  @override
  Widget build(BuildContext context) {
    if (values.length < 3) return const SizedBox(height: 34);
    return SizedBox(
      height: 34,
      width: double.infinity,
      child: CustomPaint(
        painter: _SparklinePainter(values, Palette.of(context).signal),
      ),
    );
  }
}

class _SparklinePainter extends CustomPainter {
  final List<double> values;
  final Color signal;
  _SparklinePainter(this.values, this.signal);

  @override
  void paint(Canvas canvas, Size size) {
    final peak = values.reduce((a, b) => a > b ? a : b);
    if (peak <= 0) return;

    final step = size.width / (values.length - 1);
    final path = Path();
    for (var i = 0; i < values.length; i++) {
      final x = i * step;
      final y = size.height - (values[i] / peak) * (size.height - 2) - 1;
      i == 0 ? path.moveTo(x, y) : path.lineTo(x, y);
    }

    final area = Path.from(path)
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(area, Paint()..color = signal.withValues(alpha: 0.14));

    canvas.drawPath(
      path,
      Paint()
        ..color = signal
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round,
    );
  }

  @override
  bool shouldRepaint(_SparklinePainter old) =>
      old.values != values || old.signal != signal;
}

class ProgressReadout extends StatelessWidget {
  final Progress progress;
  final String label;
  final bool paused;

  const ProgressReadout({
    super.key,
    required this.progress,
    required this.label,
    this.paused = false,
  });

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final pct = (progress.fraction * 100).clamp(0, 100);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Text(
                label,
                style: TextStyle(fontSize: 14, color: p.inkSoft),
              ),
            ),
            Text(
              '${pct.toStringAsFixed(1)}%',
              style: tabular.copyWith(
                fontSize: 26,
                fontWeight: FontWeight.w600,
                color: p.ink,
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        ClipRRect(
          borderRadius: BorderRadius.circular(999),
          child: LinearProgressIndicator(
            value: progress.fraction,
            minHeight: 8,
            backgroundColor: p.line,
            valueColor: AlwaysStoppedAnimation(p.signal),
          ),
        ),
        const SizedBox(height: 10),
        Sparkline(values: progress.history),
        const SizedBox(height: 8),
        Row(
          children: [
            _Stat(label: 'Moved', value: formatBytes(progress.transferred)),
            _Stat(
              label: 'Rate',
              value: paused ? 'paused' : formatRate(progress.bytesPerSecond),
            ),
            _Stat(
              label: 'Remaining',
              value: paused || progress.etaSeconds == null
                  ? '—'
                  : formatDuration(progress.etaSeconds!),
            ),
            _Stat(
              label: 'Elapsed',
              value: formatDuration(progress.elapsedSeconds),
            ),
          ],
        ),
      ],
    );
  }
}

class _Stat extends StatelessWidget {
  final String label;
  final String value;
  const _Stat({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label.toUpperCase(),
            style: TextStyle(
              fontSize: 9.5,
              color: p.inkFaint,
              letterSpacing: 1.2,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: tabular.copyWith(fontSize: 12.5, color: p.ink),
          ),
        ],
      ),
    );
  }
}

enum NoticeTone { info, good, error, warn }

class Notice extends StatelessWidget {
  final String text;
  final NoticeTone tone;
  const Notice(this.text, {super.key, this.tone = NoticeTone.info});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final (bg, border, fg) = switch (tone) {
      NoticeTone.info => (p.panelSoft, p.line, p.inkSoft),
      NoticeTone.good => (p.signalWash, p.signal, p.ink),
      NoticeTone.warn => (p.warnWash, p.warn, p.warn),
      NoticeTone.error => (p.dangerWash, p.danger, p.danger),
    };

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: bg,
        border: Border.all(color: border.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Text(
        text,
        style: TextStyle(fontSize: 13.5, height: 1.5, color: fg),
      ),
    );
  }
}

class Panel extends StatelessWidget {
  final Widget child;
  const Panel({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: p.panel,
        border: Border.all(color: p.line),
        borderRadius: BorderRadius.circular(18),
      ),
      child: child,
    );
  }
}

/// The headline for a batch: what it is, and how big.
class BatchLine extends StatelessWidget {
  final String name;
  final int others;
  final int totalBytes;

  const BatchLine({
    super.key,
    required this.name,
    required this.totalBytes,
    this.others = 0,
  });

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Column(
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: Text.rich(
                TextSpan(
                  text: name,
                  children: [
                    if (others > 0)
                      TextSpan(
                        text: ' and $others more',
                        style: TextStyle(color: p.inkFaint),
                      ),
                  ],
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Text(
              formatBytes(totalBytes),
              style: tabular.copyWith(fontSize: 13, color: p.inkSoft),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Divider(height: 1, color: p.line),
      ],
    );
  }
}

/// One row of the per-file list.
enum RowState { queued, active, done, failed }

class QueueRow {
  final String name;
  final String path;
  final int size;
  final int transferred;
  final RowState state;

  const QueueRow({
    required this.name,
    required this.path,
    required this.size,
    required this.transferred,
    required this.state,
  });
}

/// Every file in the batch, with its own progress.
///
/// On a folder of two hundred files the overall bar says almost nothing —
/// "which file is it stuck on" is the only question worth answering, and that
/// needs the list. Scrolls inside its own box rather than pushing the
/// controls off the screen.
class FileQueue extends StatelessWidget {
  final List<QueueRow> rows;
  final void Function(int index)? onRemove;

  const FileQueue({super.key, required this.rows, this.onRemove});

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) return const SizedBox.shrink();
    final p = Palette.of(context);

    return Container(
      constraints: const BoxConstraints(maxHeight: 260),
      decoration: BoxDecoration(
        color: p.panelSoft,
        border: Border.all(color: p.line),
        borderRadius: BorderRadius.circular(14),
      ),
      child: ListView.separated(
        shrinkWrap: true,
        padding: EdgeInsets.zero,
        itemCount: rows.length,
        separatorBuilder: (_, _) => Divider(height: 1, color: p.line),
        itemBuilder: (context, i) =>
            _QueueRowView(row: rows[i], onRemove: onRemove == null ? null : () => onRemove!(i)),
      ),
    );
  }
}

class _QueueRowView extends StatelessWidget {
  final QueueRow row;
  final VoidCallback? onRemove;

  const _QueueRowView({required this.row, this.onRemove});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final active = row.state == RowState.active;
    final pct = row.size <= 0 ? 0.0 : (row.transferred / row.size).clamp(0, 1);

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      child: Row(
        children: [
          _StateDot(state: row.state),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text.rich(
                  TextSpan(
                    children: [
                      if (row.path.isNotEmpty)
                        TextSpan(
                          text: '${row.path}/',
                          style: TextStyle(color: p.inkFaint),
                        ),
                      TextSpan(text: row.name),
                    ],
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13, color: p.ink),
                ),
                if (active) ...[
                  const SizedBox(height: 6),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(999),
                    child: LinearProgressIndicator(
                      value: pct.toDouble(),
                      minHeight: 3,
                      backgroundColor: p.line,
                      valueColor: AlwaysStoppedAnimation(p.signal),
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 10),
          Text(
            active
                ? '${(pct * 100).toStringAsFixed(0)}%'
                : formatBytes(row.size),
            style: tabular.copyWith(fontSize: 11.5, color: p.inkFaint),
          ),
          if (onRemove != null && row.state == RowState.queued)
            IconButton(
              onPressed: onRemove,
              visualDensity: VisualDensity.compact,
              iconSize: 16,
              color: p.inkFaint,
              icon: const Icon(Icons.close),
              tooltip: 'Remove ${row.name}',
            ),
        ],
      ),
    );
  }
}

class _StateDot extends StatelessWidget {
  final RowState state;
  const _StateDot({required this.state});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return switch (state) {
      RowState.done => Icon(Icons.check, size: 15, color: p.signal),
      RowState.failed => Icon(Icons.close, size: 15, color: p.danger),
      RowState.active => SizedBox(
        width: 15,
        height: 15,
        child: CircularProgressIndicator(
          strokeWidth: 2,
          color: p.signal,
        ),
      ),
      RowState.queued => Container(
        width: 7,
        height: 7,
        margin: const EdgeInsets.symmetric(horizontal: 4),
        decoration: BoxDecoration(
          color: p.lineStrong,
          shape: BoxShape.circle,
        ),
      ),
    };
  }
}

/// The share link as a QR code.
///
/// Typing a URL with a 64-character capability in its fragment is not a thing
/// anyone will do, and the desktop-to-phone hand-off is the common case.
class QrCard extends StatelessWidget {
  final String url;
  const QrCard({super.key, required this.url});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.panel,
        border: Border.all(color: p.line),
        borderRadius: BorderRadius.circular(14),
      ),
      child: QrImageView(
        data: url,
        version: QrVersions.auto,
        size: 168,
        backgroundColor: Colors.transparent,
        // Medium correction: still scans with a thumb over a corner, without
        // the density that makes a long URL unreadable on a phone.
        errorCorrectionLevel: QrErrorCorrectLevel.M,
        eyeStyle: QrEyeStyle(eyeShape: QrEyeShape.square, color: p.ink),
        dataModuleStyle: QrDataModuleStyle(
          dataModuleShape: QrDataModuleShape.square,
          color: p.ink,
        ),
      ),
    );
  }
}

/// Waiting on something with no measurable progress.
///
/// A static line of text is indistinguishable from a frozen screen, and two
/// of these waits — waking the signaling service, and the system copying a
/// large file out of shared storage — can run to tens of seconds. So:
/// something visibly moving, plus an explanation that appears only once the
/// wait has gone on long enough to be worrying.
class Working extends StatefulWidget {
  final String label;
  final String? patience;

  const Working({super.key, required this.label, this.patience});

  @override
  State<Working> createState() => _WorkingState();
}

class _WorkingState extends State<Working> {
  bool _slow = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    if (widget.patience != null) {
      _timer = Timer(const Duration(seconds: 4), () {
        if (mounted) setState(() => _slow = true);
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: p.panelSoft,
        border: Border.all(color: p.line),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            widget.label,
            style: TextStyle(fontSize: 13.5, height: 1.5, color: p.inkSoft),
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: LinearProgressIndicator(
              minHeight: 4,
              backgroundColor: p.line,
              valueColor: AlwaysStoppedAnimation(p.signal),
            ),
          ),
          AnimatedCrossFade(
            duration: const Duration(milliseconds: 350),
            crossFadeState: _slow
                ? CrossFadeState.showSecond
                : CrossFadeState.showFirst,
            firstChild: const SizedBox(width: double.infinity),
            secondChild: Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                widget.patience ?? '',
                style: TextStyle(fontSize: 12, height: 1.5, color: p.inkFaint),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
