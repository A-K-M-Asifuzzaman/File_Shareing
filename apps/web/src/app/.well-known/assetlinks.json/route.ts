/**
 * Digital Asset Links, so Android will hand a share link to the app.
 *
 * The Android client declares an intent filter for /t/ on this host with
 * `autoVerify="true"`. Android only honours that after fetching this file and
 * finding the app's signing certificate in it; without it the filter loses to
 * the browser silently — no prompt, no error, just a tab where the app should
 * have been.
 *
 * The fingerprint belongs to whichever keystore signs the release, which this
 * repo does not and should not contain, so it arrives as configuration:
 *
 *   keytool -list -v -keystore <release.jks> -alias <alias>
 *
 * and the SHA-256 line goes in ANDROID_CERT_SHA256. Several fingerprints —
 * an upload key and a Play-signed one, say — separate with commas.
 *
 * Unset, this 404s rather than serving an empty statement list: an empty list
 * is a positive claim that no app may open these links, which would be a
 * confusing way to say "not configured yet".
 */

const PACKAGE = "com.trinol.direct_transfer";

export function GET(): Response {
  const fingerprints = (process.env.ANDROID_CERT_SHA256 ?? "")
    .split(",")
    .map((f) => f.trim().toUpperCase())
    .filter(Boolean);

  if (fingerprints.length === 0) {
    return new Response("Not configured", { status: 404 });
  }

  const statements = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: PACKAGE,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];

  return Response.json(statements, {
    headers: {
      // Android re-checks this periodically; a day is long enough to spare the
      // origin and short enough that rotating a key takes effect the same week.
      "Cache-Control": "public, max-age=86400",
    },
  });
}
