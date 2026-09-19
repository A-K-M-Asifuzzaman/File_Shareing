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
  unawaited(prefetchIce());
}

/// ICE configuration, as the signaling service reports it.
class IceConfig {
  final List<Map<String, dynamic>> servers;
  final bool relayAvailable;
  const IceConfig(this.servers, this.relayAvailable);
}

const IceConfig _fallbackIce = IceConfig([
  {
    'urls': ['stun:stun.l.google.com:19302'],
  },
], false);

IceConfig _ice = _fallbackIce;
Future<IceConfig>? _icePending;

/// Ask the service for ICE servers.
///
/// TURN credentials cannot be shipped inside the app — an APK is readable —
/// so the service mints short-lived ones. Fetched early so they are in hand
/// before a connection is negotiated.
Future<IceConfig> prefetchIce() {
  _icePending ??= http
      .get(Uri.parse('$signalingUrl/api/ice'))
      .timeout(const Duration(seconds: 30))
      .then((res) {
        if (res.statusCode != 200) return _fallbackIce;
        final body = jsonDecode(res.body) as Map<String, dynamic>;
        final servers = (body['iceServers'] as List<dynamic>? ?? [])
            .cast<Map<String, dynamic>>();
        if (servers.isEmpty) return _fallbackIce;
        _ice = IceConfig(servers, body['relayAvailable'] == true);
        return _ice;
      })
      .catchError((_) => _fallbackIce);
  return _icePending!;
}

/// What has been fetched so far; STUN-only until the service replies.
IceConfig currentIce() => _ice;

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
/// Reconnects while it still matters, and stops once it does not.
///
/// Before the two peers are linked, this socket is the only way they can find
/// each other, and it drops for entirely ordinary reasons — switching to
/// another app to paste the link, a network hop, an idle proxy. Giving up
/// there would kill the transfer at exactly the moment the user is doing the
/// one thing the flow requires of them. So it retries with backoff.
///
/// After the peer connection is up, signaling is dead weight: no traffic
/// flows over it, proxies close it routinely, and a drop means nothing.
/// Callers signal that with [retireReconnect].
class SignalingChannel {
  final String sessionId;
  final Role role;
  final String token;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  bool _closed = false;

  bool _reconnect = true;
  int _attempt = 0;
  Timer? _retry;

  void Function(Map<String, dynamic>)? _onMessage;
  void Function()? _onGiveUp;

  /// Rejoining costs nothing on the server — a disconnect frees the role — and
  /// on rejoin it tells us again whether the other peer is already waiting.
  static const int _maxAttempts = 8;

  SignalingChannel(this.sessionId, this.role, this.token);

  /// Stop trying to hold the socket open. Called once the data channel is up.
  void retireReconnect() {
    _reconnect = false;
    _retry?.cancel();
    _retry = null;
  }

  Future<void> connect({
    required void Function(Map<String, dynamic> msg) onMessage,
    required void Function() onClose,
  }) async {
    _onMessage = onMessage;
    _onGiveUp = onClose;
    await _open(first: true);
  }

  Future<void> _open({bool first = false}) async {
    final onMessage = _onMessage!;
    final base = signalingUrl.replaceFirst(RegExp(r'^http'), 'ws');
    final uri = Uri.parse(
      '$base/ws?session=${Uri.encodeComponent(sessionId)}'
      '&role=${role.wire}&token=${Uri.encodeComponent(token)}',
    );

    final channel = WebSocketChannel.connect(uri);
    _channel = channel;

    try {
      // Surfaces an auth rejection: the server refuses before the upgrade, so
      // a bad capability fails here rather than opening and closing.
      await channel.ready.timeout(
        const Duration(seconds: 30),
        onTimeout: () =>
            throw Exception('The signaling service did not respond.'),
      );
    } catch (e) {
      // The very first attempt reports failure to the caller, which is how a
      // dead link or an expired session is told apart from a blip.
      if (first) rethrow;
      _scheduleRetry();
      return;
    }

    // A successful connection resets the budget, so a long wait punctuated by
    // brief drops does not slowly exhaust it.
    _attempt = 0;

    await _sub?.cancel();
    _sub = channel.stream.listen(
      (event) {
        try {
          final decoded = jsonDecode(event as String);
          if (decoded is Map<String, dynamic>) onMessage(decoded);
        } catch (_) {
          // A malformed frame from our own service is not actionable here.
        }
      },
      onDone: _handleDrop,
      onError: (_) => _handleDrop(),
    );
  }

  void _handleDrop() {
    if (_closed) return;

    // Still needed: the peers have not found each other yet.
    if (_reconnect) {
      _scheduleRetry();
      return;
    }

    _closed = true;
    _onGiveUp?.call();
  }

  void _scheduleRetry() {
    if (_closed || !_reconnect) return;

    if (_attempt >= _maxAttempts) {
      _closed = true;
      _onGiveUp?.call();
      return;
    }

    // 1s, 2s, 4s… capped, so a phone that has been asleep for a while still
    // tries often enough to be useful without hammering the service.
    final delay = Duration(
      milliseconds: (1000 * (1 << _attempt)).clamp(1000, 15000),
    );
    _attempt++;

    _retry?.cancel();
    _retry = Timer(delay, () => unawaited(_open()));
  }

  void send(Map<String, dynamic> msg) {
    final sink = _channel?.sink;
    if (sink != null && !_closed) sink.add(jsonEncode(msg));
  }

  Future<void> close() async {
    _closed = true;
    _reconnect = false;
    _retry?.cancel();
    _retry = null;
    await _sub?.cancel();
    await _channel?.sink.close();
    _channel = null;
  }
}
