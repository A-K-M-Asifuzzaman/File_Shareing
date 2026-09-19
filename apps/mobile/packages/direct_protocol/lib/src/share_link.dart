/// Share-link construction and parsing.
///
/// Pure string work, kept next to the protocol rather than the networking so
/// it can be tested without a device — and because the app and the browser
/// must agree on the exact shape of a link for either to open the other's.
library;

/// Build the link the receiver opens.
///
/// The capability goes in the fragment. Browsers never send that part to the
/// server, so it stays out of access logs and referrer headers — and the same
/// link works whether the other side opens it in a browser or in the app.
String buildShareUrlFor(
  String webAppUrl,
  String sessionId,
  String receiverToken,
) =>
    '$webAppUrl/t/${Uri.encodeComponent(sessionId)}'
    '#token=${Uri.encodeComponent(receiverToken)}';

/// Pull the session and capability back out of a share link.
///
/// Returns null for anything that is not a usable link, including one whose
/// fragment has been trimmed — some chat apps do that, and such a link cannot
/// open a transfer, so it must fail plainly rather than half-work.
({String sessionId, String token})? parseShareUrl(String raw) {
  final uri = Uri.tryParse(raw.trim());
  if (uri == null) return null;

  final segments = uri.pathSegments;
  final i = segments.indexOf('t');
  if (i < 0 || i + 1 >= segments.length) return null;
  if (segments[i + 1].isEmpty) return null;

  final token = Uri.splitQueryString(uri.fragment)['token'];
  if (token == null || token.isEmpty) return null;

  return (sessionId: segments[i + 1], token: token);
}
