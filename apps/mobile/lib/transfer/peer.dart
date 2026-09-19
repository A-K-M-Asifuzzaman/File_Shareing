import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

/// Shared WebRTC plumbing for both directions.
///
/// Everything here mirrors apps/web/src/lib/transfer/connection.ts, including
/// the parts that exist because of bugs found on the web side: candidates are
/// buffered until a remote description exists, and `peer-left` is ignored
/// once the data channel is open.

Map<String, dynamic> iceConfiguration() {
  const stun = String.fromEnvironment(
    'STUN_URLS',
    defaultValue: 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302',
  );
  const turnUrl = String.fromEnvironment('TURN_URL');

  final servers = <Map<String, dynamic>>[];
  final urls = stun
      .split(',')
      .map((s) => s.trim())
      .where((s) => s.isNotEmpty)
      .toList();
  if (urls.isNotEmpty) servers.add({'urls': urls});

  // TURN relays file bytes through a third party, so it is opt-in.
  if (turnUrl.isNotEmpty) {
    servers.add({
      'urls': turnUrl,
      'username': const String.fromEnvironment('TURN_USERNAME'),
      'credential': const String.fromEnvironment('TURN_CREDENTIAL'),
    });
  }

  return {'iceServers': servers, 'sdpSemantics': 'unified-plan'};
}

/// Holds candidates that arrive before the remote description is set.
///
/// Adding one early throws, and the connection then quietly fails to form —
/// on the web this dropped exactly the host candidates that make a local
/// connection work.
class CandidateBuffer {
  final RTCPeerConnection pc;
  final List<RTCIceCandidate> _pending = [];
  bool _remoteReady = false;

  CandidateBuffer(this.pc);

  void add(RTCIceCandidate candidate) {
    if (!_remoteReady) {
      _pending.add(candidate);
      return;
    }
    pc.addCandidate(candidate).catchError((_) {
      // A rejected candidate is normal; others usually still work.
    });
  }

  Future<void> remoteDescriptionSet() async {
    _remoteReady = true;
    for (final c in _pending) {
      try {
        await pc.addCandidate(c);
      } catch (_) {
        /* ignore */
      }
    }
    _pending.clear();
  }
}

RTCIceCandidate candidateFromJson(Map<String, dynamic> j) => RTCIceCandidate(
  j['candidate'] as String?,
  j['sdpMid'] as String?,
  (j['sdpMLineIndex'] as num?)?.toInt(),
);

Map<String, dynamic> candidateToJson(RTCIceCandidate c) => {
  'candidate': c.candidate,
  'sdpMid': c.sdpMid,
  'sdpMLineIndex': c.sdpMLineIndex,
};

void sendControl(RTCDataChannel? channel, Map<String, dynamic> msg) {
  if (channel?.state == RTCDataChannelState.RTCDataChannelOpen) {
    channel!.send(RTCDataChannelMessage(jsonEncode(msg)));
  }
}

/// Incremental SHA-256 over a stream of chunks.
///
/// Dart's crypto package exposes a chunked conversion, so the whole file
/// never has to be in memory — the same requirement the web client meets with
/// a WebAssembly hasher in a worker.
class StreamHasher {
  late final ByteConversionSink _sink;
  Digest? _digest;

  StreamHasher() {
    _sink = sha256.startChunkedConversion(
      ChunkedConversionSink<Digest>.withCallback((digests) {
        _digest = digests.single;
      }),
    );
  }

  void update(List<int> chunk) => _sink.add(chunk);

  String finish() {
    _sink.close();
    return _digest?.toString() ?? '';
  }
}

/// States both directions move through, kept deliberately close to the web
/// client's so the two UIs describe the same thing.
enum TransferState {
  idle,
  creating,
  waiting,
  connecting,
  offering,
  offered,
  transferring,
  verifying,
  complete,
  declined,
  peerGone,
  expired,
  failed,
}
