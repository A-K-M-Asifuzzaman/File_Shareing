/// Transfer rate and ETA.
///
/// Rate is smoothed over a short trailing window rather than averaged over
/// the whole transfer: an average barely moves after the first minute, so a
/// stall would keep showing a healthy number. Over a large transfer that
/// difference is the entire value of the readout.
///
/// Mirrors apps/web/src/lib/transfer/progress.ts.
class Progress {
  final int transferred;
  final int total;
  final double bytesPerSecond;
  final double? etaSeconds;

  const Progress({
    this.transferred = 0,
    this.total = 0,
    this.bytesPerSecond = 0,
    this.etaSeconds,
  });

  double get fraction => total <= 0 ? 0 : transferred / total;
}

class _Sample {
  final int at;
  final int bytes;
  const _Sample(this.at, this.bytes);
}

class ProgressMeter {
  static const int _windowMs = 5000;

  final Stopwatch _clock = Stopwatch();
  final List<_Sample> _samples = [];
  int _total = 0;
  int _transferred = 0;

  void start(int total) {
    _total = total;
    _transferred = 0;
    _samples
      ..clear()
      ..add(const _Sample(0, 0));
    _clock
      ..reset()
      ..start();
  }

  void set(int transferred) {
    _transferred = transferred;
    final now = _clock.elapsedMilliseconds;
    _samples.add(_Sample(now, transferred));

    // Keep one sample older than the window so the span stays full-length.
    var drop = 0;
    while (drop + 1 < _samples.length &&
        now - _samples[drop + 1].at > _windowMs) {
      drop++;
    }
    if (drop > 0) _samples.removeRange(0, drop);
  }

  Progress snapshot() {
    if (_total <= 0) return const Progress();

    final first = _samples.first;
    final last = _samples.last;

    var rate = 0.0;
    if (last.at > first.at) {
      rate = (last.bytes - first.bytes) * 1000 / (last.at - first.at);
    }

    final remaining = _total - _transferred;
    return Progress(
      transferred: _transferred,
      total: _total,
      bytesPerSecond: rate,
      etaSeconds: rate > 0 && remaining > 0 ? remaining / rate : null,
    );
  }
}
