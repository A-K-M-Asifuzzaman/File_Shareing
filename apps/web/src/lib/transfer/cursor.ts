/**
 * Where the next wire bytes belong.
 *
 * In v2 the files of a batch stream back to back with nothing between them —
 * no per-chunk header, no round trip per file. That is only possible because
 * the manifest gives every size up front, so position in the batch is plain
 * arithmetic. A chunk can therefore straddle a file boundary, and several
 * small files can land inside one chunk.
 *
 * That arithmetic is the part that silently corrupts a transfer if it is
 * wrong — an off-by-one puts the last byte of one file at the front of the
 * next and both fail their checksums — so it lives here, away from sinks,
 * workers and data channels, where it can be tested on its own.
 */

export interface Piece {
  /** Index into the manifest's file list. */
  index: number;
  /** Offset into the wire chunk this piece starts at. */
  offset: number;
  length: number;
  /** True when this piece completes that file. */
  endsFile: boolean;
}

export interface Split {
  pieces: Piece[];
  /** Bytes past the end of the last declared file. Anything above 0 is a lie. */
  overflow: number;
}

export class BatchCursor {
  private index = 0;
  private inFile = 0n;
  private total = 0n;

  private readonly sizes: bigint[];

  constructor(sizes: bigint[]) {
    this.sizes = sizes;
  }

  /** Index of the file currently being written. */
  get fileIndex(): number {
    return this.index;
  }

  /** Bytes accepted across the whole batch. */
  get received(): bigint {
    return this.total;
  }

  /** Bytes accepted into the current file. */
  get receivedInFile(): bigint {
    return this.inFile;
  }

  get finished(): boolean {
    return this.index >= this.sizes.length;
  }

  /**
   * Split `length` bytes of wire data across the remaining files and advance.
   *
   * The cursor moves as if every returned piece will be written, because it
   * will be: the caller walks the pieces in order and any failure fails the
   * whole batch.
   */
  split(length: number): Split {
    const pieces: Piece[] = [];
    let offset = 0;

    while (offset < length && this.index < this.sizes.length) {
      const size = this.sizes[this.index]!;
      const remaining = Number(size - this.inFile);
      const take = Math.min(remaining, length - offset);

      const endsFile = this.inFile + BigInt(take) >= size;
      pieces.push({ index: this.index, offset, length: take, endsFile });

      offset += take;
      this.inFile += BigInt(take);
      this.total += BigInt(take);

      if (endsFile) {
        this.index++;
        this.inFile = 0n;
      }
    }

    return { pieces, overflow: length - offset };
  }
}
