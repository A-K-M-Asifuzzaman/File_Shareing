/// Where the next wire bytes belong.
///
/// In v2 the files of a batch stream back to back with nothing between them —
/// no per-chunk header, no round trip per file. That is only possible because
/// the manifest gives every size up front, so position in the batch is plain
/// arithmetic. A chunk can therefore straddle a file boundary, and several
/// small files can land inside one chunk.
///
/// That arithmetic is the part that silently corrupts a transfer if it is
/// wrong — an off-by-one puts the last byte of one file at the front of the
/// next and both fail their checksums — so it lives here, away from files,
/// hashing and data channels, where it can be tested on its own.
///
/// Mirrors apps/web/src/lib/transfer/cursor.ts.
library;

class Piece {
  /// Index into the manifest's file list.
  final int index;

  /// Offset into the wire chunk this piece starts at.
  final int offset;
  final int length;

  /// True when this piece completes that file.
  final bool endsFile;

  const Piece({
    required this.index,
    required this.offset,
    required this.length,
    required this.endsFile,
  });

  @override
  String toString() => 'Piece($index, $offset, $length, ends: $endsFile)';
}

class Split {
  final List<Piece> pieces;

  /// Bytes past the end of the last declared file. Anything above 0 is a lie.
  final int overflow;

  const Split(this.pieces, this.overflow);
}

class BatchCursor {
  final List<int> _sizes;
  int _index = 0;
  int _inFile = 0;
  int _total = 0;

  BatchCursor(List<int> sizes) : _sizes = List.unmodifiable(sizes);

  /// Index of the file currently being written.
  int get fileIndex => _index;

  /// Bytes accepted across the whole batch.
  int get received => _total;

  /// Bytes accepted into the current file.
  int get receivedInFile => _inFile;

  bool get finished => _index >= _sizes.length;

  /// Split [length] bytes of wire data across the remaining files and advance.
  ///
  /// The cursor moves as if every returned piece will be written, because it
  /// will be: the caller walks the pieces in order and any failure fails the
  /// whole batch.
  Split split(int length) {
    final pieces = <Piece>[];
    var offset = 0;

    while (offset < length && _index < _sizes.length) {
      final size = _sizes[_index];
      final remaining = size - _inFile;
      final take = remaining < length - offset ? remaining : length - offset;
      final endsFile = _inFile + take >= size;

      pieces.add(
        Piece(index: _index, offset: offset, length: take, endsFile: endsFile),
      );

      offset += take;
      _inFile += take;
      _total += take;

      if (endsFile) {
        _index++;
        _inFile = 0;
      }
    }

    return Split(pieces, length - offset);
  }
}
