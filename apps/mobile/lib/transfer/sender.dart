import 'package:direct_protocol/direct_protocol.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'peer.dart';

import 'signaling.dart';

/// A file chosen on this device, plus where it sits in the batch.
class PickedFile {
  final File file;

  /// What to call it on the other side. The picker's name, not the path.
  final String name;

  /// Relative directory inside the batch, '' for a file on its own.
  final String path;

  /// Size at the moment it was picked.
  ///
  /// Carried rather than read on demand: the staging list rebuilds on every
  /// keystroke in the note field, and stat-ing 500 files synchronously inside
  /// build() would make the screen stutter for no reason. The sender still
  /// re-reads the real length before it builds the manifest, so a file that
  /// changed on disk in between cannot desync the wire format.
  final int size;

  const PickedFile({
    required this.file,
    required this.name,
    required this.size,
    this.path = '',
  });
}

enum FileState { queued, sending, sent, verified, failed }

class FileStatus {
  final ManifestEntry entry;
  FileState state;
  int transferred;

  FileStatus(this.entry, {this.state = FileState.queued, this.transferred = 0});
}

class SenderSnapshot {
  final TransferState state;
  final String? shareUrl;

  /// Progress across the whole batch.
  final Progress progress;
  final List<FileStatus> files;

  /// Index into [files] currently on the wire, or -1.
  final int current;
  final int totalBytes;
  final String note;
  final String? error;

  /// True while the user has paused the transfer by hand.
  final bool paused;

  const SenderSnapshot({
    required this.state,
    required this.progress,
    required this.files,
    required this.current,
    required this.totalBytes,
    this.note = '',
    this.shareUrl,
    this.error,
    this.paused = false,
  });

  /// The headline name: the first file, which the UI qualifies with a count.
  String get label => files.isEmpty ? 'transfer' : files.first.entry.name;
}

/// Reads files off this device and streams them to one peer.
///
/// The read loop never holds more than one chunk, and stops entirely when the
/// local send buffer fills, when the receiver says its disk is behind, or when
/// the user pauses — the same brakes the web sender uses.
class FileSender {
  static const int bufferHigh = 1024 * 1024;
  static const int bufferLow = 256 * 1024;

  final List<PickedFile> picked;
  final String note;
  final void Function(SenderSnapshot) onChange;

  SignalingChannel? _signaling;
  RTCPeerConnection? _pc;
  RTCDataChannel? _control;
  RTCDataChannel? _data;
  CandidateBuffer? _candidates;
  Manifest? _manifest;

  final ProgressMeter _meter = ProgressMeter();
  final List<FileStatus> _statuses = [];
  TransferState _state = TransferState.idle;
  String? _shareUrl;
  String? _error;
  int _totalBytes = 0;
  int _current = -1;
  int _sentTotal = 0;

  bool _linked = false;
  bool _cancelled = false;
  bool _remotePaused = false;
  bool _userPaused = false;
  Completer<void>? _resume;

  FileSender({
    required this.picked,
    required this.onChange,
    this.note = '',
  });

  void _emit([TransferState? state]) {
    if (state != null) _state = state;
    onChange(
      SenderSnapshot(
        state: _state,
        shareUrl: _shareUrl,
        progress: _meter.snapshot(),
        files: List.unmodifiable(_statuses),
        current: _current,
        totalBytes: _totalBytes,
        note: sanitizeNote(note),
        error: _error,
        paused: _userPaused,
      ),
    );
  }

  void _fail(String message) {
    // Keep the first cause, and leave a finished transfer alone: the receiver
    // closes the peer connection the moment it has verified everything, which
    // arrives here as a failed connection state a beat after
    // TRANSFER_VERIFIED. Without this a perfect transfer ends by replacing
    // 'sent and verified' with 'could not open a connection'.
    if (_state == TransferState.failed ||
        _state == TransferState.complete ||
        _state == TransferState.declined) {
      return;
    }
    _error = message;
    if (_current >= 0 && _current < _statuses.length) {
      _statuses[_current].state = FileState.failed;
    }
    _emit(TransferState.failed);
    unawaited(dispose());
  }

  Future<void> start() async {
    if (picked.isEmpty) return _fail('No files were chosen.');
    if (picked.length > maxFilesPerTransfer) {
      return _fail(
        'That is ${picked.length} files. One transfer carries at most '
        '$maxFilesPerTransfer — send them in batches.',
      );
    }

    // Sizes have to be read before anything else: they are what the manifest
    // is, and the receiver routes bytes by them.
    _statuses.clear();
    _totalBytes = 0;
    for (final p in picked) {
      final size = await p.file.length();
      _totalBytes += size;
      _statuses.add(
        FileStatus(
          ManifestEntry(
            fileId: _randomId(),
            name: sanitizeFilename(p.name),
            path: sanitizePath(p.path),
            size: size,
            mimeType: 'application/octet-stream',
            lastModified: (await p.file.lastModified()).millisecondsSinceEpoch,
          ),
        ),
      );
    }

    if (_totalBytes <= 0) {
      return _fail(
        picked.length == 1 ? 'That file is empty.' : 'Those files are all empty.',
      );
    }
    if (_totalBytes > maxTransferBytes) {
      return _fail(
        'That is ${formatBytes(_totalBytes)} in total. The limit is '
        '${formatBytes(maxTransferBytes)}.',
      );
    }

    _emit(TransferState.creating);

    late SessionCredentials creds;
    try {
      creds = await createSession();
    } catch (e) {
      return _fail(
        e is Exception ? e.toString().replaceFirst('Exception: ', '') : '$e',
      );
    }

    _shareUrl = buildShareUrl(creds.sessionId, creds.receiverToken);
    _signaling = SignalingChannel(
      creds.sessionId,
      Role.sender,
      creds.senderToken,
    );

    try {
      await _signaling!.connect(
        onMessage: _onSignal,
        onClose: () {
          // Only reached after reconnection has been exhausted, or once
          // the peers are linked and signaling no longer matters.
          if (!_linked &&
              (_state == TransferState.waiting ||
                  _state == TransferState.connecting)) {
            _fail(
              'Lost contact with the transfer service and could not get it '
              'back. The link is no longer valid — start a new transfer.',
            );
          }
        },
      );
    } catch (_) {
      return _fail('Could not reach the signaling service.');
    }

    _emit(TransferState.waiting);
  }

  void _onSignal(Map<String, dynamic> msg) {
    unawaited(() async {
      try {
        switch (msg['type']) {
          case 'peer-joined':
            await _negotiate();
          case 'answer':
            await _pc?.setRemoteDescription(
              RTCSessionDescription(msg['sdp'] as String, 'answer'),
            );
            await _candidates?.remoteDescriptionSet();
          case 'ice':
            _candidates?.add(
              candidateFromJson(msg['candidate'] as Map<String, dynamic>),
            );
          case 'peer-left':
            // Signaling goes idle during a transfer and proxies close it, so
            // this says nothing once linked. The data channel reports real loss.
            if (!_linked) {
              _fail('The receiver left before the transfer started.');
            }
        }
      } catch (_) {
        _fail('Connection negotiation failed.');
      }
    }());
  }

  Future<void> _negotiate() async {
    if (_pc != null) return; // a re-join must not restart negotiation
    _emit(TransferState.connecting);

    final pc = await createPeerConnection(await iceConfiguration());
    _pc = pc;
    _candidates = CandidateBuffer(pc);

    pc.onIceCandidate = (c) =>
        _signaling?.send({'type': 'ice', 'candidate': candidateToJson(c)});
    pc.onConnectionState = (s) {
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _fail(unreachableMessage());
      }
    };

    final init = RTCDataChannelInit()..ordered = true;
    _control = await pc.createDataChannel('control', init);
    _data = await pc.createDataChannel(
      'data',
      RTCDataChannelInit()..ordered = true,
    );

    _control!.onMessage = _onControl;

    final opened = Completer<void>();
    _data!.onDataChannelState = (s) {
      if (s == RTCDataChannelState.RTCDataChannelOpen && !opened.isCompleted) {
        opened.complete();
      }
      if (s == RTCDataChannelState.RTCDataChannelClosed &&
          (_state == TransferState.transferring ||
              _state == TransferState.verifying)) {
        _fail('The receiver disconnected before the transfer finished.');
      }
    };

    final offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    _signaling?.send({'type': 'offer', 'sdp': offer.sdp});

    await opened.future.timeout(
      const Duration(seconds: 45),
      onTimeout: () => throw TimeoutException('data channel never opened'),
    );
    _linked = true;
    _signaling?.retireReconnect();

    sendControl(_control, {
      'type': 'HELLO',
      'protocolVersion': protocolVersion,
      'role': 'sender',
    });

    _manifest = Manifest(
      transferId: _randomId(),
      chunkSize: defaultChunkSize,
      totalBytes: _totalBytes,
      files: _statuses.map((s) => s.entry).toList(),
      note: sanitizeNote(note),
    );
    sendControl(_control, _manifest!.toMessage());
    _emit(TransferState.offering);
  }

  void _onControl(RTCDataChannelMessage message) {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(message.text) as Map<String, dynamic>;
    } catch (_) {
      return;
    }

    switch (msg['type']) {
      case 'HELLO':
        if (msg['protocolVersion'] != protocolVersion) {
          _fail(
            'The other device speaks protocol v${msg['protocolVersion']}, '
            'this one speaks v$protocolVersion. One of you needs to update.',
          );
        }
      case 'MANIFEST_ACCEPT':
        unawaited(_sendBatch());
      case 'MANIFEST_REJECT':
        _emit(TransferState.declined);
        unawaited(dispose());
      case 'PAUSE':
        _remotePaused = true;
      case 'RESUME':
        _remotePaused = false;
        _wake();
      case 'FILE_VERIFIED':
        final id = msg['fileId'];
        for (final s in _statuses) {
          if (s.entry.fileId == id) {
            s.state = FileState.verified;
            _emit();
            break;
          }
        }
      case 'TRANSFER_VERIFIED':
        _emit(TransferState.complete);
      case 'TRANSFER_FAILED':
        _fail(
          (msg['message'] as String?) ?? 'The receiver reported a failure.',
        );
    }
  }

  /// The read loop, across the whole batch.
  ///
  /// Files stream back to back with no round trip between them: the receiver
  /// knows every size from the manifest, so it routes bytes by counting.
  /// Memory stays flat — one chunk at a time, and the loop blocks whenever
  /// anything is behind.
  Future<void> _sendBatch() async {
    final data = _data;
    final manifest = _manifest;
    if (data == null || manifest == null) return;

    _meter.start(_totalBytes);
    _emit(TransferState.transferring);

    sendControl(_control, {
      'type': 'TRANSFER_START',
      'transferId': manifest.transferId,
    });

    try {
      for (var i = 0; i < picked.length; i++) {
        if (_cancelled) return;
        _current = i;
        _statuses[i].state = FileState.sending;
        await _sendOne(picked[i].file, _statuses[i], manifest.chunkSize, data);
        _statuses[i].state = FileState.sent;
        _emit();
      }

      _current = -1;
      _emit(TransferState.verifying);

      // Control and data are separate SCTP streams, so TRANSFER_COMPLETE can
      // overtake chunks still queued. Let the buffer empty first.
      await _flush(data);

      sendControl(_control, {
        'type': 'TRANSFER_COMPLETE',
        'transferId': manifest.transferId,
      });
      // Stays in verifying until TRANSFER_VERIFIED: the receiver may still be
      // writing, and claiming success early is how someone closes the app and
      // ends up with an unopenable file.
    } catch (e) {
      sendControl(_control, {
        'type': 'TRANSFER_FAILED',
        'transferId': manifest.transferId,
        'code': 'send_failed',
        'message': 'The sender could not finish the transfer.',
      });
      _fail(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  /// Stream one file and announce its digest.
  Future<void> _sendOne(
    File file,
    FileStatus status,
    int chunkSize,
    RTCDataChannel data,
  ) async {
    final hasher = StreamHasher();
    final handle = await file.open();
    var offset = 0;
    final size = status.entry.size;

    try {
      while (offset < size) {
        if (_cancelled) throw Exception('The transfer was cancelled.');
        if (data.state != RTCDataChannelState.RTCDataChannelOpen) {
          throw Exception('The connection dropped mid-transfer.');
        }

        // The receiver's disk is behind, or the user pressed pause.
        if (_remotePaused || _userPaused) {
          _resume ??= Completer<void>();
          await _resume!.future.timeout(
            const Duration(minutes: 30),
            onTimeout: () =>
                throw Exception('The transfer stayed paused too long.'),
          );
          continue;
        }

        // Our own send buffer is full; let it drain.
        if ((data.bufferedAmount ?? 0) > bufferHigh) {
          await Future<void>.delayed(const Duration(milliseconds: 20));
          continue;
        }

        final want = min(chunkSize, size - offset);
        final chunk = await handle.read(want);
        if (chunk.isEmpty) break;

        await data.send(RTCDataChannelMessage.fromBinary(chunk));
        hasher.update(chunk);

        offset += chunk.length;
        status.transferred = offset;
        _sentTotal += chunk.length;
        _meter.set(_sentTotal);
        _emit();
      }

      sendControl(_control, {
        'type': 'FILE_DONE',
        'fileId': status.entry.fileId,
        'sha256': hasher.finish(),
      });
    } finally {
      await handle.close();
    }
  }

  Future<void> _flush(RTCDataChannel data) async {
    final deadline = DateTime.now().add(const Duration(minutes: 5));
    while (DateTime.now().isBefore(deadline)) {
      if ((data.bufferedAmount ?? 0) == 0) return;
      if (data.state != RTCDataChannelState.RTCDataChannelOpen) {
        throw Exception(
          'The connection dropped before the last bytes were sent.',
        );
      }
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    throw Exception('Timed out flushing the last bytes.');
  }

  void _wake() {
    if (_remotePaused || _userPaused) return;
    _resume?.complete();
    _resume = null;
  }

  /// Hold the transfer without dropping the connection.
  ///
  /// Purely local: the read loop stops pulling bytes, the send buffer drains,
  /// and SCTP flow control does the rest. No protocol message is needed, and
  /// the peer connection stays up so resuming is instant.
  void pause() {
    if (_userPaused) return;
    _userPaused = true;
    _emit();
  }

  void resume() {
    if (!_userPaused) return;
    _userPaused = false;
    _wake();
    _emit();
  }

  void cancel() {
    _cancelled = true;
    _userPaused = false;
    _resume?.complete();
    _resume = null;
    unawaited(dispose());
  }

  Future<void> dispose() async {
    _resume?.complete();
    _resume = null;
    await _control?.close();
    await _data?.close();
    await _pc?.close();
    await _signaling?.close();
    _pc = null;
    _signaling = null;
  }
}

String _randomId() {
  final r = Random.secure();
  return List.generate(
    16,
    (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}
