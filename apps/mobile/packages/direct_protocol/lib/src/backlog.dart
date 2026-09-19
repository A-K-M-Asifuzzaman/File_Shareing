/// Tracks bytes taken off the wire but not yet written to disk, and decides
/// when to ask the sender to pause.
///
/// Phone storage is frequently slower than the link, and WebRTC stops nobody
/// on our behalf once a message has been handed to us. Unchecked, the gap
/// between network speed and disk speed accumulates in memory — which a
/// 100 GB transfer cannot afford, least of all on a phone.
///
/// Mirrors apps/web/src/lib/transfer/backlog.ts.
class Backlog {
  final int high;
  final int low;

  int _bytes = 0;
  bool _paused = false;

  Backlog({this.high = 8 * 1024 * 1024, this.low = 2 * 1024 * 1024});

  /// Record arrived bytes. Returns true when the sender should be paused.
  bool arrived(int size) {
    _bytes += size;
    if (!_paused && _bytes >= high) {
      _paused = true;
      return true;
    }
    return false;
  }

  /// Record bytes written. Returns true when the sender should be resumed.
  ///
  /// Pass the size measured on arrival, not one read back off a buffer that
  /// may since have been consumed — the web client had exactly that bug and
  /// the backlog never drained.
  bool written(int size) {
    _bytes -= size;
    if (_paused && _bytes <= low) {
      _paused = false;
      return true;
    }
    return false;
  }

  int get depth => _bytes;
  bool get isPaused => _paused;
}
