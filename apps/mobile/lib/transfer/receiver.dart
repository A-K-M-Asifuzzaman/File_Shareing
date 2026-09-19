import 'package:direct_protocol/direct_protocol.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'peer.dart';

import 'signaling.dart';

class ReceiverSnapshot {
  final TransferState state;
  final FileOffer? offer;
  final Progress progress;
  final String? error;
  final String? savedPath;
  final bool verified;

  const ReceiverSnapshot({
    required this.state,
    required this.progress,
    this.offer,
    this.error,
    this.savedPath,
    this.verified = false,
  });
}

/// Receives a file and streams it straight to storage.
///
/// Nothing accumulates: each chunk is appended to the file and fed to the
/// hash, and the sender is paused whenever the write queue runs deep.
class FileReceiver {
  final String sessionId;
  final String token;

  /// Where to put the finished file. The caller picks this so the UI can ask
  /// the user, and so a test can point it somewhere harmless.
  final Future<String> Function(FileOffer offer) chooseDestination;
  final void Function(ReceiverSnapshot) onChange;

  SignalingChannel? _signaling;
  RTCPeerConnection? _pc;
  RTCDataChannel? _control;
  CandidateBuffer? _candidates;
  StreamHasher? _hasher;
  IOSink? _sink;
  File? _partial;
  String? _finalPath;

  final ProgressMeter _meter = ProgressMeter();
  final Backlog _backlog = Backlog();
  Future<void> _writes = Future<void>.value();

  TransferState _state = TransferState.connecting;
  FileOffer? _offer;
  String? _error;
  bool _verified = false;
  bool _linked = false;
  int _received = 0;

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
        offer: _offer,
        progress: _meter.snapshot(),
        error: _error,
        savedPath: _finalPath,
        verified: _verified,
      ),
    );
  }

  void _fail(String message, [TransferState state = TransferState.failed]) {
    if (_state == TransferState.failed) return;
    _error = message;
    unawaited(_discardPartial());
    _emit(state);
    unawaited(dispose());
  }

  /// A partial file is worse than no file: it has a real name and a plausible
  /// size, and looks fine until it will not open. Delete it outright.
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

    final pc = await createPeerConnection(iceConfiguration());
    _pc = pc;
    _candidates = CandidateBuffer(pc);

    pc.onIceCandidate = (c) =>
        _signaling?.send({'type': 'ice', 'candidate': candidateToJson(c)});
    pc.onConnectionState = (s) {
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _fail(
          'Could not open a direct connection to the sender. One of the two '
          'networks is blocking peer-to-peer traffic.',
        );
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
            'this app speaks v$protocolVersion.',
          );
        }
      case 'FILE_OFFER':
        try {
          _offer = FileOffer.fromMessage(msg);
        } catch (e) {
          return _fail('The sender sent an invalid file offer.');
        }
        _emit(TransferState.offered);
      case 'TRANSFER_COMPLETE':
        unawaited(_finish(msg['sha256'] as String? ?? ''));
      case 'TRANSFER_FAILED':
        _fail((msg['message'] as String?) ?? 'The sender reported a failure.');
    }
  }

  /// Accept the offer and start writing.
  Future<void> accept() async {
    final offer = _offer;
    if (offer == null || _control == null) return;

    try {
      _finalPath = await chooseDestination(offer);
      _partial = File('$_finalPath.part');
      _sink = _partial!.openWrite();
    } catch (e) {
      return _fail('Could not open a place to save the file.');
    }

    _hasher = StreamHasher();
    _received = 0;
    _meter.start(offer.size);
    _emit(TransferState.transferring);

    sendControl(_control, {'type': 'FILE_ACCEPT', 'fileId': offer.fileId});
  }

  void decline() {
    if (_control != null && _offer != null) {
      sendControl(_control, {
        'type': 'FILE_REJECT',
        'fileId': _offer!.fileId,
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

    if (_backlog.arrived(size) && _control != null && _offer != null) {
      sendControl(_control, {'type': 'PAUSE', 'fileId': _offer!.fileId});
    }

    // Writes must land in arrival order, so they go through one queue.
    _writes = _writes.then((_) async {
      await _writeChunk(chunk);
      if (_backlog.written(size) && _control != null && _offer != null) {
        sendControl(_control, {
          'type': 'RESUME',
          'fileId': _offer!.fileId,
          'fromOffset': _received.toString(),
        });
      }
    });
  }

  Future<void> _writeChunk(List<int> chunk) async {
    final sink = _sink;
    final offer = _offer;
    if (sink == null || offer == null || _hasher == null) return;

    // The sender is a stranger: refuse more than it declared rather than
    // letting it write unbounded data to this device.
    if (_received + chunk.length > offer.size) {
      return _fail(
        'The sender sent more data than it declared. Transfer aborted.',
      );
    }

    try {
      sink.add(chunk);
      _hasher!.update(chunk);
    } catch (e) {
      return _fail('Could not write the file to storage.');
    }

    _received += chunk.length;
    _meter.set(_received);
    _emit();
  }

  Future<void> _finish(String expectedSha256) async {
    _emit(TransferState.verifying);

    // The last chunks may still be queued behind the disk.
    await _writes;

    final offer = _offer;
    if (offer == null || _sink == null) return;

    if (_received != offer.size) {
      sendControl(_control, {
        'type': 'TRANSFER_FAILED',
        'fileId': offer.fileId,
        'code': 'short_read',
        'message': 'Receiver got fewer bytes than declared.',
      });
      return _fail(
        'The transfer ended early, so the file is incomplete and was discarded.',
      );
    }

    final actual = _hasher!.finish();
    if (expectedSha256.isEmpty || actual != expectedSha256) {
      return _fail(
        'File verification failed. The received file did not match the '
        "sender's checksum, so it was discarded.",
      );
    }

    try {
      await _sink!.flush();
      await _sink!.close();
      _sink = null;
      // Only now does it get its real name: a .part file cannot be mistaken
      // for a finished one.
      await _partial!.rename(_finalPath!);
      _partial = null;
    } catch (e) {
      return _fail('Could not finish writing the file.');
    }

    _verified = true;

    // Tell the sender before tearing down, so it stops showing "sending"
    // while we were finishing the write.
    sendControl(_control, {
      'type': 'TRANSFER_VERIFIED',
      'fileId': offer.fileId,
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
