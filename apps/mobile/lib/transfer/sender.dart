import 'package:direct_protocol/direct_protocol.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'peer.dart';

import 'signaling.dart';

class SenderSnapshot {
  final TransferState state;
  final String? shareUrl;
  final Progress progress;
  final String? error;
  final String fileName;
  final int fileSize;

  const SenderSnapshot({
    required this.state,
    required this.progress,
    required this.fileName,
    required this.fileSize,
    this.shareUrl,
    this.error,
  });
}

/// Reads a file off this device and streams it to one peer.
///
/// The read loop never holds more than one chunk, and stops entirely when
/// either the local send buffer fills or the receiver says its disk is behind
/// — the same two brakes the web sender uses.
class FileSender {
  static const int bufferHigh = 1024 * 1024;
  static const int bufferLow = 256 * 1024;

  final File file;
  final String displayName;
  final void Function(SenderSnapshot) onChange;

  SignalingChannel? _signaling;
  RTCPeerConnection? _pc;
  RTCDataChannel? _control;
  RTCDataChannel? _data;
  CandidateBuffer? _candidates;
  StreamHasher? _hasher;
  FileOffer? _offer;

  final ProgressMeter _meter = ProgressMeter();
  TransferState _state = TransferState.idle;
  String? _shareUrl;
  String? _error;
  int _size = 0;

  bool _linked = false;
  bool _cancelled = false;
  bool _remotePaused = false;
  Completer<void>? _resume;

  FileSender({
    required this.file,
    required this.displayName,
    required this.onChange,
  });

  void _emit([TransferState? state]) {
    if (state != null) _state = state;
    onChange(
      SenderSnapshot(
        state: _state,
        shareUrl: _shareUrl,
        progress: _meter.snapshot(),
        error: _error,
        fileName: displayName,
        fileSize: _size,
      ),
    );
  }

  void _fail(String message) {
    if (_state == TransferState.failed) return; // keep the first cause
    _error = message;
    _emit(TransferState.failed);
    unawaited(dispose());
  }

  Future<void> start() async {
    _size = await file.length();

    if (_size <= 0) return _fail('That file is empty.');
    if (_size > maxTransferBytes) {
      return _fail(
        'That file is ${formatBytes(_size)}. The limit is '
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
          // Meaningless once the peer connection exists.
          if (!_linked &&
              (_state == TransferState.waiting ||
                  _state == TransferState.connecting)) {
            _fail('The transfer session expired before anyone connected.');
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
      } catch (e) {
        _fail('Connection negotiation failed.');
      }
    }());
  }

  Future<void> _negotiate() async {
    if (_pc != null) return; // a re-join must not restart negotiation
    _emit(TransferState.connecting);

    final pc = await createPeerConnection(iceConfiguration());
    _pc = pc;
    _candidates = CandidateBuffer(pc);

    pc.onIceCandidate = (c) =>
        _signaling?.send({'type': 'ice', 'candidate': candidateToJson(c)});
    pc.onConnectionState = (s) {
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _fail(
          'Could not open a direct connection. One of the two networks is '
          'blocking peer-to-peer traffic.',
        );
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

    sendControl(_control, {
      'type': 'HELLO',
      'protocolVersion': protocolVersion,
      'role': 'sender',
    });

    _offer = FileOffer(
      transferId: _randomId(),
      fileId: _randomId(),
      name: sanitizeFilename(displayName),
      size: _size,
      mimeType: 'application/octet-stream',
      lastModified: (await file.lastModified()).millisecondsSinceEpoch,
      chunkSize: defaultChunkSize,
    );
    sendControl(_control, _offer!.toMessage());
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
            'this one speaks v$protocolVersion.',
          );
        }
      case 'FILE_ACCEPT':
        unawaited(_sendFile());
      case 'FILE_REJECT':
        _emit(TransferState.declined);
        unawaited(dispose());
      case 'PAUSE':
        _remotePaused = true;
      case 'RESUME':
        _remotePaused = false;
        _resume?.complete();
        _resume = null;
      case 'TRANSFER_VERIFIED':
        _emit(TransferState.complete);
      case 'TRANSFER_FAILED':
        _fail(
          (msg['message'] as String?) ?? 'The receiver reported a failure.',
        );
    }
  }

  /// The read loop. Memory stays flat: one chunk at a time, and the loop
  /// blocks whenever either side is behind.
  Future<void> _sendFile() async {
    final data = _data;
    final offer = _offer;
    if (data == null || offer == null) return;

    _meter.start(_size);
    _emit(TransferState.transferring);

    _hasher = StreamHasher();
    sendControl(_control, {'type': 'TRANSFER_START', 'fileId': offer.fileId});

    final handle = await file.open();
    var offset = 0;

    try {
      while (offset < _size) {
        if (_cancelled) return;
        if (data.state != RTCDataChannelState.RTCDataChannelOpen) {
          throw Exception('The connection dropped mid-transfer.');
        }

        // The receiver's disk is behind; stop reading entirely.
        if (_remotePaused) {
          _resume ??= Completer<void>();
          await _resume!.future.timeout(
            const Duration(minutes: 10),
            onTimeout: () =>
                throw Exception('The receiver stopped responding.'),
          );
          continue;
        }

        // Our own send buffer is full; let it drain.
        final buffered = data.bufferedAmount ?? 0;
        if (buffered > bufferHigh) {
          await Future<void>.delayed(const Duration(milliseconds: 20));
          continue;
        }

        final want = min(offer.chunkSize, _size - offset);
        final chunk = await handle.read(want);
        if (chunk.isEmpty) break;

        await data.send(RTCDataChannelMessage.fromBinary(chunk));
        _hasher!.update(chunk);

        offset += chunk.length;
        _meter.set(offset);
        _emit();
      }

      _emit(TransferState.verifying);

      // Control and data are separate SCTP streams, so TRANSFER_COMPLETE can
      // overtake chunks still queued. Let the buffer empty first.
      await _flush(data);

      sendControl(_control, {
        'type': 'TRANSFER_COMPLETE',
        'fileId': offer.fileId,
        'sha256': _hasher!.finish(),
      });
      // Stays in verifying until TRANSFER_VERIFIED: the receiver may still be
      // writing, and claiming success early is how someone closes the app and
      // ends up with an unopenable file.
    } catch (e) {
      sendControl(_control, {
        'type': 'TRANSFER_FAILED',
        'fileId': offer.fileId,
        'code': 'send_failed',
        'message': 'The sender could not finish the transfer.',
      });
      _fail(e.toString().replaceFirst('Exception: ', ''));
    } finally {
      await handle.close();
    }
  }

  Future<void> _flush(RTCDataChannel data) async {
    final deadline = DateTime.now().add(const Duration(minutes: 5));
    while (DateTime.now().isBefore(deadline)) {
      final buffered = data.bufferedAmount ?? 0;
      if (buffered == 0) return;
      if (data.state != RTCDataChannelState.RTCDataChannelOpen) {
        throw Exception(
          'The connection dropped before the last bytes were sent.',
        );
      }
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    throw Exception('Timed out flushing the last bytes.');
  }

  void cancel() {
    _cancelled = true;
    _resume?.complete();
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
