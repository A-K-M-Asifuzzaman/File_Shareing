import 'package:direct_protocol/direct_protocol.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'peer.dart';

import 'signaling.dart';

enum IncomingState { queued, receiving, verified, failed }

class IncomingFile {
  final ManifestEntry entry;
  IncomingState state;
  int transferred;

  IncomingFile(
    this.entry, {
    this.state = IncomingState.queued,
    this.transferred = 0,
  });
}

class ReceiverSnapshot {
  final TransferState state;
  final Manifest? manifest;
  final List<IncomingFile> files;

  /// Index into [files] currently being written, or -1.
  final int current;
  final Progress progress;
  final String? error;

  /// The directory the batch was written into, once chosen.
  final String? savedTo;
  final bool verified;

  const ReceiverSnapshot({
    required this.state,
    required this.progress,
    required this.files,
    required this.current,
    this.manifest,
    this.error,
    this.savedTo,
    this.verified = false,
  });
}

/// Receives a batch of files and streams each straight to storage.
///
/// Nothing accumulates: each chunk is appended to the file it belongs to and
/// fed to that file's hash, and the sender is paused whenever the write queue
/// runs deep.
class FileReceiver {
  final String sessionId;
  final String token;

  /// Where to put the batch. The caller picks this so the UI can ask the
  /// user, and so a test can point it somewhere harmless.
  final Future<String> Function(Manifest manifest) chooseDestination;
  final void Function(ReceiverSnapshot) onChange;

  SignalingChannel? _signaling;
  RTCPeerConnection? _pc;
  RTCDataChannel? _control;
  CandidateBuffer? _candidates;

  StreamHasher? _hasher;
  IOSink? _sink;
  File? _partial;
  File? _target;

  final ProgressMeter _meter = ProgressMeter();
  final Backlog _backlog = Backlog();
  Future<void> _writes = Future<void>.value();

  /// Decides which file each wire byte belongs to; see cursor.dart.
  BatchCursor _cursor = BatchCursor(const []);

  /// Digests announced by the sender, keyed by fileId.
  ///
  /// FILE_DONE travels on the control channel and can overtake the tail of
  /// its own file on the data channel, so it is parked here until our own
  /// byte count says that file is whole.
  final Map<String, String> _digests = {};
  final Map<String, Completer<void>> _digestWaiters = {};

  TransferState _state = TransferState.connecting;
  Manifest? _manifest;
  final List<IncomingFile> _statuses = [];
  String? _error;
  String? _savedTo;
  bool _verified = false;
  bool _linked = false;
  int _index = 0;
  int _received = 0;

  /// Set the moment the batch is failed. `_state` cannot stand in for this:
  /// a failure can land while `_finish` is awaiting the write queue.
  bool _aborted = false;

  FileReceiver({
    required this.sessionId,
    required this.token,
    required this.chooseDestination,
    required this.onChange,
  });

  void _emit([TransferState? state]) {
    if (state != null) _state = state;
    onChange(
      ReceiverSnapshot(
        state: _state,
        manifest: _manifest,
        files: List.unmodifiable(_statuses),
        current: _state == TransferState.transferring ? _index : -1,
        progress: _meter.snapshot(),
        error: _error,
        savedTo: _savedTo,
        verified: _verified,
      ),
    );
  }

  void _fail(String message, [TransferState state = TransferState.failed]) {
    // A finished transfer is immune: the sender tears the connection down once
    // it has our TRANSFER_VERIFIED, and that must not turn a success into a
    // connection error on this side either.
    if (_aborted ||
        _state == TransferState.complete ||
        _state == TransferState.declined) {
      return;
    }
    _aborted = true;
    _error = message;
    if (_index < _statuses.length) {
      _statuses[_index].state = IncomingState.failed;
    }
    unawaited(_discardPartial());
    _emit(state);
    unawaited(dispose());
  }

  /// A partial file is worse than no file: it has a real name and a plausible
  /// size, and looks fine until it will not open. Delete it outright.
  ///
  /// Files completed and verified earlier in the same batch are already closed
  /// under their real names and are deliberately left alone.
  Future<void> _discardPartial() async {
    try {
      await _sink?.flush();
      await _sink?.close();
    } catch (_) {
      /* already gone */
    }
    _sink = null;
    try {
      if (_partial != null && await _partial!.exists()) {
        await _partial!.delete();
      }
    } catch (_) {
      /* best effort */
    }
    _partial = null;
  }

  Future<void> start() async {
    _emit(TransferState.connecting);
    _signaling = SignalingChannel(sessionId, Role.receiver, token);

    try {
      await _signaling!.connect(
        onMessage: _onSignal,
        onClose: () {
          if (!_linked &&
              (_state == TransferState.connecting ||
                  _state == TransferState.waiting)) {
            _fail(
              'This transfer link has expired, or the sender closed their app.',
              TransferState.expired,
            );
          }
        },
      );
    } catch (_) {
      return _fail(
        'This transfer link is invalid or has expired.',
        TransferState.expired,
      );
    }

    _emit(TransferState.waiting);
  }

  void _onSignal(Map<String, dynamic> msg) {
    unawaited(() async {
      try {
        switch (msg['type']) {
          case 'offer':
            await _answer(msg['sdp'] as String);
          case 'ice':
            _candidates?.add(
              candidateFromJson(msg['candidate'] as Map<String, dynamic>),
            );
          case 'peer-left':
            if (!_linked && _state != TransferState.complete) {
              _fail('The sender is no longer online.', TransferState.peerGone);
            }
        }
      } catch (_) {
        _fail('Connection negotiation failed.');
      }
    }());
  }

  Future<void> _answer(String sdp) async {
    if (_pc != null) return;

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

    // The sender creates both channels; we attach as they arrive.
    pc.onDataChannel = (channel) {
      if (channel.label == 'control') {
        _control = channel;
        channel.onMessage = _onControl;
      } else if (channel.label == 'data') {
        channel.onMessage = _onChunk;
        channel.onDataChannelState = (s) {
          if (s == RTCDataChannelState.RTCDataChannelOpen) {
            _linked = true;
            _signaling?.retireReconnect();
          }
          if (s == RTCDataChannelState.RTCDataChannelClosed &&
              _state == TransferState.transferring) {
            _fail(
              'The sender disconnected before the transfer finished.',
              TransferState.peerGone,
            );
          }
        };
        if (channel.state == RTCDataChannelState.RTCDataChannelOpen) {
          _linked = true;
          _signaling?.retireReconnect();
        }
      }
    };

    await pc.setRemoteDescription(RTCSessionDescription(sdp, 'offer'));
    await _candidates!.remoteDescriptionSet();

    final answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    _signaling?.send({'type': 'answer', 'sdp': answer.sdp});
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
            'The sender speaks protocol v${msg['protocolVersion']}, '
            'this app speaks v$protocolVersion. One of you needs to update.',
          );
        }
      case 'MANIFEST':
        try {
          _manifest = Manifest.fromMessage(msg);
        } catch (e) {
          return _fail(
            e is FormatException
                ? e.message
                : 'The sender sent an invalid file list.',
          );
        }
        _statuses
          ..clear()
          ..addAll(_manifest!.files.map(IncomingFile.new));
        _emit(TransferState.offered);
      case 'FILE_DONE':
        final id = msg['fileId'] as String? ?? '';
        _digests[id] = msg['sha256'] as String? ?? '';
        _digestWaiters.remove(id)?.complete();
      case 'TRANSFER_COMPLETE':
        unawaited(_finish());
      case 'TRANSFER_FAILED':
        _fail((msg['message'] as String?) ?? 'The sender reported a failure.');
    }
  }

  /// Accept the batch and start writing.
  Future<void> accept() async {
    final manifest = _manifest;
    if (manifest == null || _control == null) return;

    try {
      _savedTo = await chooseDestination(manifest);
    } catch (_) {
      return _fail('Could not open a place to save the files.');
    }

    _received = 0;
    _index = 0;
    _cursor = BatchCursor(manifest.files.map((f) => f.size).toList());

    try {
      await _openCurrent();
    } catch (_) {
      return _fail('Could not open a place to save the files.');
    }

    _meter.start(manifest.totalBytes);
    _emit(TransferState.transferring);

    sendControl(_control, {
      'type': 'MANIFEST_ACCEPT',
      'transferId': manifest.transferId,
    });
  }

  void decline() {
    if (_control != null && _manifest != null) {
      sendControl(_control, {
        'type': 'MANIFEST_REJECT',
        'transferId': _manifest!.transferId,
        'reason': 'declined',
      });
    }
    _emit(TransferState.declined);
    unawaited(dispose());
  }

  void _onChunk(RTCDataChannelMessage message) {
    if (!message.isBinary) return;
    final chunk = message.binary;

    // Measure now and keep it: the buffer is handed onward below.
    final size = chunk.length;

    if (_backlog.arrived(size) && _control != null && _manifest != null) {
      sendControl(_control, {
        'type': 'PAUSE',
        'transferId': _manifest!.transferId,
      });
    }

    // Writes must land in arrival order, so they go through one queue.
    _writes = _writes.then((_) async {
      await _consume(chunk);
      if (_backlog.written(size) && _control != null && _manifest != null) {
        sendControl(_control, {
          'type': 'RESUME',
          'transferId': _manifest!.transferId,
          'fromOffset': _received.toString(),
        });
      }
    });
  }

  /// Route one wire chunk into one or more files.
  ///
  /// Files stream back to back with nothing between them, so a chunk can
  /// straddle a boundary. The manifest gives every size up front, which is
  /// what makes plain byte counting enough to know where each file ends.
  Future<void> _consume(List<int> chunk) async {
    // Not a state check: _finish flips the state to verifying and only then
    // awaits this queue, so anything still queued behind it would be dropped
    // on the floor and the batch would report itself short. The tail of a
    // transfer legitimately lands while the UI already says "verifying".
    if (_aborted || _savedTo == null) return;

    final split = _cursor.split(chunk.length);

    if (split.overflow > 0) {
      // The sender is a stranger: refuse more than it declared rather than
      // letting it write unbounded data to this device.
      return _fail(
        'The sender sent more data than it declared. Transfer aborted.',
      );
    }

    for (final piece in split.pieces) {
      final entry = _manifest?.files.elementAtOrNull(piece.index);
      final sink = _sink;
      // `_index` is which file the open sink belongs to; the cursor has
      // already advanced past every piece in this chunk. If those ever
      // disagree, the next bytes would be written into the wrong file and
      // still pass that file's checksum, so this is checked, not assumed.
      if (entry == null ||
          sink == null ||
          _hasher == null ||
          piece.index != _index) {
        return _fail(
          'The transfer arrived out of step with its file list. Aborted.',
        );
      }

      final whole = piece.offset == 0 && piece.length == chunk.length;
      final bytes = whole
          ? chunk
          : chunk.sublist(piece.offset, piece.offset + piece.length);

      try {
        sink.add(bytes);
        _hasher!.update(bytes);
      } catch (_) {
        return _fail('Could not write the file to storage.');
      }

      _received += piece.length;
      _statuses[piece.index].transferred += piece.length;
      _meter.set(_received);

      if (piece.endsFile) {
        if (!await _closeCurrent(piece.index, entry)) return;
      }
      _emit();
    }
  }

  /// Open the sink and hasher for the file at [_index].
  Future<void> _openCurrent() async {
    final entry = _manifest?.files.elementAtOrNull(_index);
    if (entry == null || _savedTo == null) return;

    final dir = Directory(
      entry.path.isEmpty ? _savedTo! : '$_savedTo/${entry.path}',
    );
    await dir.create(recursive: true);

    _target = File(await _freeName(dir, entry.name));
    _partial = File('${_target!.path}.part');
    _sink = _partial!.openWrite();
    _hasher = StreamHasher();
    _statuses[_index].state = IncomingState.receiving;
  }

  /// Finish the current file: check its digest, close it, move to the next.
  ///
  /// Returns false when the batch has been failed, so the caller stops.
  Future<bool> _closeCurrent(int index, ManifestEntry entry) async {
    final hasher = _hasher;
    final sink = _sink;
    if (hasher == null || sink == null) return false;

    final actual = hasher.finish();
    _hasher = null;

    // The digest rides the control channel, which can lag the data channel's
    // tail by a few milliseconds. Wait for it rather than guessing.
    final expected = await _digestFor(entry.fileId);

    if (expected == null || expected.isEmpty || actual != expected) {
      _fail(
        '“${entry.name}” failed verification — the received bytes did not '
        "match the sender's checksum, so it was discarded.",
      );
      return false;
    }

    try {
      await sink.flush();
      await sink.close();
      _sink = null;
      // Only now does it get its real name: a .part file cannot be mistaken
      // for a finished one.
      await _partial!.rename(_target!.path);
      _partial = null;
    } catch (_) {
      _sink = null;
      _fail('Could not finish writing the file.');
      return false;
    }

    _statuses[index].state = IncomingState.verified;
    sendControl(_control, {'type': 'FILE_VERIFIED', 'fileId': entry.fileId});

    // The next file, not wherever the cursor has got to: the cursor is already
    // past every piece in this chunk, and several small files can finish
    // inside one of them.
    _index = index + 1;

    if (_index < (_manifest?.files.length ?? 0)) {
      try {
        await _openCurrent();
      } catch (_) {
        _fail('Could not open the next file for writing.');
        return false;
      }
    }
    return true;
  }

  /// Resolve once the sender has announced this file's digest.
  Future<String?> _digestFor(String fileId) async {
    final known = _digests[fileId];
    if (known != null) return known;

    final waiter = _digestWaiters.putIfAbsent(fileId, Completer<void>.new);
    await waiter.future.timeout(
      const Duration(minutes: 2),
      onTimeout: () => throw TimeoutException('digest never arrived'),
    );
    return _digests[fileId];
  }

  Future<void> _finish() async {
    if (_aborted || _verified) return;
    _emit(TransferState.verifying);

    // The last chunks may still be queued behind the disk.
    await _writes.catchError((_) {});
    if (_aborted) return;

    final manifest = _manifest;
    if (manifest == null) return;

    if (_received != manifest.totalBytes) {
      sendControl(_control, {
        'type': 'TRANSFER_FAILED',
        'transferId': manifest.transferId,
        'code': 'short_read',
        'message': 'Receiver got fewer bytes than declared.',
      });
      return _fail(
        'The transfer ended early, so the last file is incomplete and was '
        'discarded. Files already verified are intact.',
      );
    }

    _verified = true;

    // Tell the sender before tearing down, so it stops showing "sending"
    // while we were finishing the write.
    sendControl(_control, {
      'type': 'TRANSFER_VERIFIED',
      'transferId': manifest.transferId,
    });

    _emit(TransferState.complete);
    unawaited(dispose());
  }

  void cancel() {
    unawaited(_discardPartial());
    unawaited(dispose());
  }

  Future<void> dispose() async {
    await _control?.close();
    await _pc?.close();
    await _signaling?.close();
    _pc = null;
    _signaling = null;
  }
}

/// A name that is free on disk.
///
/// Silently replacing someone's file would be worse than an awkward name, so
/// a collision becomes 'report (2).pdf'.
Future<String> _freeName(Directory dir, String name) async {
  final dot = name.lastIndexOf('.');
  final stem = dot > 0 ? name.substring(0, dot) : name;
  final ext = dot > 0 ? name.substring(dot) : '';

  for (var i = 1; i < 1000; i++) {
    final candidate = i == 1 ? '${dir.path}/$name' : '${dir.path}/$stem ($i)$ext';
    // The .part sibling counts as taken: a transfer in flight owns that name.
    if (!await File(candidate).exists() &&
        !await File('$candidate.part').exists()) {
      return candidate;
    }
  }
  return '${dir.path}/$stem-${DateTime.now().millisecondsSinceEpoch}$ext';
}
