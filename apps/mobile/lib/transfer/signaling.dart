import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'package:direct_protocol/direct_protocol.dart';

/// Where the signaling service lives. Override at build time with
/// --dart-define=SIGNALING_URL=https://...
const String signalingUrl = String.fromEnvironment(
  'SIGNALING_URL',
  defaultValue: 'https://file-sharing-signaling.onrender.com',
);

/// Base of the web client, used to build links a browser can open.
const String webAppUrl = String.fromEnvironment(
  'WEB_APP_URL',
  defaultValue: 'https://direct-file-transfer.vercel.app',
);

class SessionCredentials {
  final String sessionId;
  final String senderToken;
  final String receiverToken;
  final int protocolVersion;

  const SessionCredentials({
    required this.sessionId,
    required this.senderToken,
    required this.receiverToken,
    required this.protocolVersion,
  });
}

/// Poke the signaling service so it is awake before anyone needs it.
///
/// The service sleeps when idle and the first request after that pays the
/// whole cold start — up to about a minute. Waking it as the app opens moves
/// that wait into the time someone spends choosing a file, rather than into a
/// spinner after they have committed.
///
/// Fire and forget: if it fails, createSession reports it properly later.
void warmUp() {
  unawaited(
    http
        .get(Uri.parse('$signalingUrl/healthz'))
        .timeout(const Duration(seconds: 60))
        .then((_) {}, onError: (_) {}),
  );
}

/// Mint a session. Only the sender does this; the receiver arrives with a link.
Future<SessionCredentials> createSession() async {
  final res = await http
      .post(Uri.parse('$signalingUrl/api/sessions'))
      .timeout(const Duration(seconds: 30));

  if (res.statusCode == 429) {
    throw Exception(
      'Too many transfers started from here. Wait a minute and try again.',
    );
  }
  if (res.statusCode != 201) {
    throw Exception('Could not reach the signaling service.');
  }

  final body = jsonDecode(res.body) as Map<String, dynamic>;
  return SessionCredentials(
    sessionId: body['sessionId'] as String,
    senderToken: body['senderToken'] as String,
    receiverToken: body['receiverToken'] as String,
    protocolVersion: body['protocolVersion'] as int? ?? protocolVersion,
  );
}

/// Build the link the receiver opens, against the configured web app.
String buildShareUrl(String sessionId, String receiverToken) =>
    buildShareUrlFor(webAppUrl, sessionId, receiverToken);

/// Thin WebSocket wrapper over the signaling service.
///
/// Deliberately not reconnecting. Once the peer connection is up signaling is
/// no longer needed, and callers must treat a dropped socket as meaningless
/// after that point — proxies close idle sockets and no signaling traffic
/// flows during a transfer.
class SignalingChannel {
  final String sessionId;
  final Role role;
  final String token;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  bool _closed = false;

  SignalingChannel(this.sessionId, this.role, this.token);

  Future<void> connect({
    required void Function(Map<String, dynamic> msg) onMessage,
    required void Function() onClose,
  }) async {
    final base = signalingUrl.replaceFirst(RegExp(r'^http'), 'ws');
    final uri = Uri.parse(
      '$base/ws?session=${Uri.encodeComponent(sessionId)}'
      '&role=${role.wire}&token=${Uri.encodeComponent(token)}',
    );

    final channel = WebSocketChannel.connect(uri);
    _channel = channel;

    // Surfaces an auth rejection: the server refuses before the upgrade, so a
    // bad capability fails here rather than opening and closing.
    await channel.ready.timeout(
      const Duration(seconds: 30),
      onTimeout: () =>
          throw Exception('The signaling service did not respond.'),
    );

    _sub = channel.stream.listen(
      (event) {
        try {
          final decoded = jsonDecode(event as String);
          if (decoded is Map<String, dynamic>) onMessage(decoded);
        } catch (_) {
          // A malformed frame from our own service is not actionable here.
        }
      },
      onDone: () {
        if (!_closed) {
          _closed = true;
          onClose();
        }
      },
      onError: (_) {
        if (!_closed) {
          _closed = true;
          onClose();
        }
      },
    );
  }

  void send(Map<String, dynamic> msg) {
    final sink = _channel?.sink;
    if (sink != null && !_closed) sink.add(jsonEncode(msg));
  }

  Future<void> close() async {
    _closed = true;
    await _sub?.cancel();
    await _channel?.sink.close();
    _channel = null;
  }
}
