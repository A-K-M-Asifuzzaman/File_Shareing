/// Wire protocol v1. Mirrors protocol/README.md and the TypeScript in
/// apps/web/src/lib/transfer/protocol.ts — change all three together.
///
/// Dart has a real int64, so the decimal-string convention costs nothing here.
/// It exists because JavaScript does not, and the same bytes have to survive
/// a trip through the web client.
library;

const int protocolVersion = 1;

/// 100 GB, decimal. The number the UI shows is the number we enforce.
const int maxTransferBytes = 100000000000;

/// Default chunk size, clamped at runtime to what SCTP negotiated.
const int defaultChunkSize = 64 * 1024;

enum Role { sender, receiver }

extension RoleWire on Role {
  String get wire => this == Role.sender ? 'sender' : 'receiver';
}

/// A file offer, as it crosses the control channel.
class FileOffer {
  final String transferId;
  final String fileId;
  final String name;
  final int size;
  final String mimeType;
  final int lastModified;
  final int chunkSize;

  const FileOffer({
    required this.transferId,
    required this.fileId,
    required this.name,
    required this.size,
    required this.mimeType,
    required this.lastModified,
    required this.chunkSize,
  });

  Map<String, dynamic> toMessage() => {
    'type': 'FILE_OFFER',
    'transferId': transferId,
    'fileId': fileId,
    'name': name,
    // Byte counts are decimal strings on the wire: see protocol/README.md.
    'size': size.toString(),
    'mimeType': mimeType,
    'lastModified': lastModified,
    'chunkSize': chunkSize,
  };

  /// Parse an offer from an untrusted peer.
  ///
  /// The sender is a stranger on the internet and `name` ends up as a path on
  /// this device, so everything is validated and nothing is taken on trust.
  factory FileOffer.fromMessage(Map<String, dynamic> m) {
    if (m['type'] != 'FILE_OFFER') {
      throw FormatException('expected FILE_OFFER, got ${m['type']}');
    }

    final size = parseByteCount(m['size'], 'size');
    if (size <= 0) throw const FormatException('file size must be positive');
    if (size > maxTransferBytes) {
      throw FormatException(
        'file exceeds the ${formatBytes(maxTransferBytes)} limit',
      );
    }

    final chunkSize = m['chunkSize'];
    if (chunkSize is! int || chunkSize < 1024 || chunkSize > 1024 * 1024) {
      throw const FormatException('chunk size out of range');
    }

    final lastModified = m['lastModified'];

    return FileOffer(
      transferId: _clip(m['transferId'], 128),
      fileId: _clip(m['fileId'], 128),
      name: sanitizeFilename(m['name']),
      size: size,
      mimeType: _clip(m['mimeType'], 255),
      lastModified: lastModified is int
          ? lastModified
          : DateTime.now().millisecondsSinceEpoch,
      chunkSize: chunkSize,
    );
  }
}

String _clip(Object? v, int max) {
  final s = v?.toString() ?? '';
  return s.length <= max ? s : s.substring(0, max);
}

/// Byte counts are decimal strings on the wire; reject anything else.
int parseByteCount(Object? raw, String field) {
  if (raw is! String || !RegExp(r'^\d{1,20}$').hasMatch(raw)) {
    throw FormatException('$field must be a decimal string');
  }
  final parsed = int.tryParse(raw);
  if (parsed == null) throw FormatException('$field does not fit in an int64');
  return parsed;
}

/// A filename from a remote peer is attacker-controlled.
///
/// Reduced to a single path segment so it cannot escape the directory we save
/// into, with control characters dropped. Matches the web client's rules so
/// the same offer produces the same filename on both platforms.
String sanitizeFilename(Object? raw) {
  final printable = (raw?.toString() ?? '').runes
      .where((c) => c > 0x1f && c != 0x7f)
      .map(String.fromCharCode)
      .join();

  final base = printable.split(RegExp(r'[/\\]')).last;
  var cleaned = base.replaceFirst(RegExp(r'^\.+'), '').trim();
  if (cleaned.length > 200) cleaned = cleaned.substring(0, 200);

  return cleaned.isEmpty ? 'received-file' : cleaned;
}

/// Decimal units, matching how the 100 GB limit is defined.
String formatBytes(num bytes) {
  if (bytes.isNaN || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];

  var n = bytes.toDouble();
  var unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit++;
  }
  final digits = unit == 0 ? 0 : (n < 10 ? 1 : 0);
  return '${n.toStringAsFixed(digits)} ${units[unit]}';
}

String formatRate(double bytesPerSecond) {
  if (bytesPerSecond <= 0 || !bytesPerSecond.isFinite) return '—';
  return '${formatBytes(bytesPerSecond)}/s';
}

String formatDuration(double seconds) {
  if (!seconds.isFinite || seconds < 0) return '—';
  if (seconds < 60) return '${seconds.ceil()}s';

  final m = seconds ~/ 60;
  final s = (seconds % 60).round();
  if (m < 60) return '${m}m ${s}s';

  return '${m ~/ 60}h ${m % 60}m';
}
