/// Wire protocol v2. Mirrors protocol/README.md and the TypeScript in
/// apps/web/src/lib/transfer/protocol.ts — change all three together.
///
/// Dart has a real int64, so the decimal-string convention costs nothing here.
/// It exists because JavaScript does not, and the same bytes have to survive
/// a trip through the web client.
///
/// v2 replaces v1's single-file exchange with a manifest: one offer describes
/// the whole batch, and the files then stream back to back with no per-file
/// round trip. A single file is a batch of one.
library;

const int protocolVersion = 2;

/// 100 GB, decimal. The number the UI shows is the number we enforce, and it
/// applies to a whole transfer rather than to each file in it.
const int maxTransferBytes = 100000000000;

/// Bounds the manifest itself rather than the bytes.
const int maxFilesPerTransfer = 500;

/// Default chunk size, clamped at runtime to what SCTP negotiated.
const int defaultChunkSize = 64 * 1024;

enum Role { sender, receiver }

extension RoleWire on Role {
  String get wire => this == Role.sender ? 'sender' : 'receiver';
}

/// One file inside a manifest.
class ManifestEntry {
  final String fileId;

  /// Display name. Never a path: separators do not survive sanitizing.
  final String name;

  /// Relative directory inside the batch, '' for a file sent on its own.
  final String path;
  final int size;
  final String mimeType;
  final int lastModified;

  const ManifestEntry({
    required this.fileId,
    required this.name,
    required this.path,
    required this.size,
    required this.mimeType,
    required this.lastModified,
  });

  /// Where this file goes, relative to the destination directory.
  String get relativePath => path.isEmpty ? name : '$path/$name';

  Map<String, dynamic> toJson() => {
    'fileId': fileId,
    'name': name,
    'path': path,
    // Byte counts are decimal strings on the wire: see protocol/README.md.
    'size': size.toString(),
    'mimeType': mimeType,
    'lastModified': lastModified,
  };
}

/// Everything a transfer carries, announced once before any bytes move.
class Manifest {
  final String transferId;
  final int chunkSize;
  final int totalBytes;
  final List<ManifestEntry> files;

  /// Free text the sender typed alongside the files. May be empty.
  final String note;

  const Manifest({
    required this.transferId,
    required this.chunkSize,
    required this.totalBytes,
    required this.files,
    this.note = '',
  });

  Map<String, dynamic> toMessage() => {
    'type': 'MANIFEST',
    'transferId': transferId,
    'chunkSize': chunkSize,
    'totalBytes': totalBytes.toString(),
    if (note.isNotEmpty) 'note': note,
    'files': files.map((f) => f.toJson()).toList(),
  };

  /// Parse a manifest from an untrusted peer.
  ///
  /// The sender is a stranger on the internet and every `name` and `path` ends
  /// up as a path on this device, so everything is validated and nothing is
  /// taken on trust — including the declared total, which is recomputed.
  factory Manifest.fromMessage(Map<String, dynamic> m) {
    if (m['type'] != 'MANIFEST') {
      throw FormatException('expected MANIFEST, got ${m['type']}');
    }

    final raw = m['files'];
    if (raw is! List || raw.isEmpty) {
      throw const FormatException('the manifest lists no files');
    }
    if (raw.length > maxFilesPerTransfer) {
      throw FormatException(
        'a transfer can carry at most $maxFilesPerTransfer files',
      );
    }

    final chunkSize = m['chunkSize'];
    if (chunkSize is! int || chunkSize < 1024 || chunkSize > 1024 * 1024) {
      throw const FormatException('chunk size out of range');
    }

    final files = <ManifestEntry>[];
    var total = 0;
    for (final item in raw) {
      if (item is! Map) throw const FormatException('malformed file entry');
      final entry = Map<String, dynamic>.from(item);

      final size = parseByteCount(entry['size'], 'size');
      if (size <= 0) throw const FormatException('file size must be positive');

      final lastModified = entry['lastModified'];
      files.add(
        ManifestEntry(
          fileId: _clip(entry['fileId'], 128),
          name: sanitizeFilename(entry['name']),
          path: sanitizePath(entry['path']),
          size: size,
          mimeType: _clip(entry['mimeType'], 255),
          lastModified: lastModified is int
              ? lastModified
              : DateTime.now().millisecondsSinceEpoch,
        ),
      );
      total += size;
    }

    if (total > maxTransferBytes) {
      throw FormatException(
        'the transfer exceeds the ${formatBytes(maxTransferBytes)} limit',
      );
    }
    if (parseByteCount(m['totalBytes'], 'totalBytes') != total) {
      throw const FormatException(
        "the manifest's total does not match its files",
      );
    }

    return Manifest(
      transferId: _clip(m['transferId'], 128),
      chunkSize: chunkSize,
      totalBytes: total,
      files: files,
      note: sanitizeNote(m['note']),
    );
  }
}

String _clip(Object? v, int max) {
  final s = v?.toString() ?? '';
  return s.length <= max ? s : s.substring(0, max);
}

String _printable(Object? raw) => (raw?.toString() ?? '').runes
    .where((c) => c > 0x1f && c != 0x7f)
    .map(String.fromCharCode)
    .join();

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
/// the same manifest produces the same filename on both platforms.
String sanitizeFilename(Object? raw) {
  final base = _printable(raw).split(RegExp(r'[/\\]')).last;
  var cleaned = base.replaceFirst(RegExp(r'^\.+'), '').trim();
  if (cleaned.length > 200) cleaned = cleaned.substring(0, 200);

  return cleaned.isEmpty ? 'received-file' : cleaned;
}

/// A relative directory path from a remote peer, for recreating a sent folder.
///
/// Every segment goes through the same rules as a filename, and any segment
/// that sanitizes to nothing — '..', '.', '' — is dropped rather than
/// substituted, so a hostile path collapses toward the destination directory
/// instead of climbing out of it.
String sanitizePath(Object? raw) {
  final segments = _printable(raw)
      .split(RegExp(r'[/\\]'))
      .map((seg) {
        var s = seg.replaceFirst(RegExp(r'^\.+'), '').trim();
        if (s.length > 200) s = s.substring(0, 200);
        return s;
      })
      .where((seg) => seg.isNotEmpty)
      .toList();

  // A pathological depth is not worth recreating on someone's disk.
  return segments.take(16).join('/');
}

/// The sender's note is free text that lands in the UI; keep it short and clean.
String sanitizeNote(Object? raw) {
  if (raw == null) return '';
  final cleaned = raw
      .toString()
      .runes
      .where((c) => c == 0x0a || (c > 0x1f && c != 0x7f))
      .map(String.fromCharCode)
      .join();
  return cleaned.length <= 2000 ? cleaned : cleaned.substring(0, 2000);
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

/// '3 files' / '1 file', for the many places that say it.
String countFiles(int n) => n == 1 ? '1 file' : '$n files';
