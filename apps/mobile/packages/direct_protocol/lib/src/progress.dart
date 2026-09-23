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

  /// Recent rate samples, oldest first, for the throughput sparkline.
  final List<double> history;

  /// Seconds since the transfer started.
  final double elapsedSeconds;

  const Progress({
    this.transferred = 0,
    this.total = 0,
    this.bytesPerSecond = 0,
    this.etaSeconds,
    this.history = const [],
    this.elapsedSeconds = 0,
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
  static const int _tickMs = 500;
  static const int _historyLength = 48;

  final Stopwatch _clock = Stopwatch();
  final List<_Sample> _samples = [];

  /// One rate reading per tick, capped — the sparkline's data.
  final List<double> _rates = [];
  int _lastTick = 0;

  int _total = 0;
  int _transferred = 0;

  void start(int total) {
    _total = total;
    _transferred = 0;
    _lastTick = 0;
    _samples
      ..clear()
      ..add(const _Sample(0, 0));
    _rates.clear();
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

    // Sample the smoothed rate on a fixed cadence, so the sparkline's x axis
    // is time rather than 'however often chunks happened to land'.
    if (now - _lastTick >= _tickMs) {
      _lastTick = now;
      _rates.add(_rate());
      if (_rates.length > _historyLength) _rates.removeAt(0);
    }
  }

  double _rate() {
    final first = _samples.first;
    final last = _samples.last;
    if (last.at <= first.at) return 0;
    return (last.bytes - first.bytes) * 1000 / (last.at - first.at);
  }

  Progress snapshot() {
    if (_total <= 0) return const Progress();

    final rate = _rate();
    final remaining = _total - _transferred;

    return Progress(
      transferred: _transferred,
      total: _total,
      bytesPerSecond: rate,
      etaSeconds: rate > 0 && remaining > 0 ? remaining / rate : null,
      history: List.unmodifiable(_rates),
      elapsedSeconds: _clock.elapsedMilliseconds / 1000,
    );
  }
}
