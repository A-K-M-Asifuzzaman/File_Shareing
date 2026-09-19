import 'dart:async';

import 'package:direct_protocol/direct_protocol.dart';
import 'package:flutter/material.dart';

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
    return Column(
      children: [
        SizedBox(
          height: 44,
          child: AnimatedBuilder(
            animation: _c,
            builder: (_, __) => CustomPaint(
              painter: _EndpointsPainter(
                t: _c.value,
                live: widget.live,
                done: widget.done,
                error: widget.error,
              ),
              size: const Size(double.infinity, 44),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              widget.from.toUpperCase(),
              style: const TextStyle(
                fontSize: 11,
                color: Palette.inkFaint,
                letterSpacing: 1,
              ),
            ),
            Text(
              widget.to.toUpperCase(),
              style: const TextStyle(
                fontSize: 11,
                color: Palette.inkFaint,
                letterSpacing: 1,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _EndpointsPainter extends CustomPainter {
  final double t;
  final bool live, done, error;

  _EndpointsPainter({
    required this.t,
    required this.live,
    required this.done,
    required this.error,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final y = size.height / 2;
    final left = Offset(10, y);
    final right = Offset(size.width - 10, y);

    final pathColor = error
        ? Palette.danger
        : (live || done)
        ? Palette.signal
        : Palette.lineStrong;

    final track = Paint()
      ..color = pathColor.withValues(alpha: done ? 1 : 0.35)
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(left.translate(14, 0), right.translate(-14, 0), track);

    // Packets moving left to right while the transfer is live.
    if (live) {
      final dot = Paint()..color = Palette.signal;
      final span = (right.dx - 14) - (left.dx + 14);
      for (var i = 0; i < 4; i++) {
        final p = ((t + i / 4) % 1.0);
        canvas.drawCircle(Offset(left.dx + 14 + span * p, y), 3, dot);
      }
    }

    canvas.drawCircle(left, 7, Paint()..color = Palette.ink);

    if (done || live) {
      canvas.drawCircle(right, 7, Paint()..color = Palette.signal);
    } else {
      canvas.drawCircle(
        right,
        7,
        Paint()
          ..color = Palette.inkFaint
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2,
      );
    }
  }

  @override
  bool shouldRepaint(_EndpointsPainter old) =>
      old.t != t || old.live != live || old.done != done || old.error != error;
}

class ProgressReadout extends StatelessWidget {
  final Progress progress;
  final String label;

  const ProgressReadout({
    super.key,
    required this.progress,
    required this.label,
  });

  @override
  Widget build(BuildContext context) {
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
                style: const TextStyle(fontSize: 14, color: Palette.inkSoft),
              ),
            ),
            Text(
              '${pct.toStringAsFixed(1)}%',
              style: tabular.copyWith(
                fontSize: 26,
                fontWeight: FontWeight.w600,
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
            backgroundColor: Palette.line,
            valueColor: const AlwaysStoppedAnimation(Palette.signal),
          ),
        ),
        const SizedBox(height: 18),
        Row(
          children: [
            _Stat(
              label: 'Transferred',
              value: formatBytes(progress.transferred),
            ),
            _Stat(label: 'Rate', value: formatRate(progress.bytesPerSecond)),
            _Stat(
              label: 'Remaining',
              value: progress.etaSeconds == null
                  ? '—'
                  : formatDuration(progress.etaSeconds!),
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
  Widget build(BuildContext context) => Expanded(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label.toUpperCase(),
          style: const TextStyle(
            fontSize: 10,
            color: Palette.inkFaint,
            letterSpacing: 1.2,
          ),
        ),
        const SizedBox(height: 4),
        Text(value, style: tabular.copyWith(fontSize: 13, color: Palette.ink)),
      ],
    ),
  );
}

class Notice extends StatelessWidget {
  final String text;
  final NoticeTone tone;
  const Notice(this.text, {super.key, this.tone = NoticeTone.info});

  @override
  Widget build(BuildContext context) {
    final (bg, border, fg) = switch (tone) {
      NoticeTone.info => (Palette.panelSoft, Palette.line, Palette.inkSoft),
      NoticeTone.good => (Palette.signalWash, Palette.signal, Palette.ink),
      NoticeTone.error => (Palette.dangerWash, Palette.danger, Palette.danger),
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

enum NoticeTone { info, good, error }

class Panel extends StatelessWidget {
  final Widget child;
  const Panel({super.key, required this.child});

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: Palette.panel,
      border: Border.all(color: Palette.line),
      borderRadius: BorderRadius.circular(18),
    ),
    child: child,
  );
}

class FileLine extends StatelessWidget {
  final String name;
  final int size;
  const FileLine({super.key, required this.name, required this.size});

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: 12),
          Text(
            formatBytes(size),
            style: tabular.copyWith(fontSize: 13, color: Palette.inkSoft),
          ),
        ],
      ),
      const SizedBox(height: 16),
      const Divider(height: 1, color: Palette.line),
    ],
  );
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
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: Palette.panelSoft,
        border: Border.all(color: Palette.line),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            widget.label,
            style: const TextStyle(
              fontSize: 13.5,
              height: 1.5,
              color: Palette.inkSoft,
            ),
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: const LinearProgressIndicator(
              minHeight: 4,
              backgroundColor: Palette.line,
              valueColor: AlwaysStoppedAnimation(Palette.signal),
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
                style: const TextStyle(
                  fontSize: 12,
                  height: 1.5,
                  color: Palette.inkFaint,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
