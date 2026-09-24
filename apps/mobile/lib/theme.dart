import 'package:flutter/material.dart';

/// The one colour the product spends.
///
/// Mirrors the accents in apps/web/src/app/globals.css — same names, same
/// values — so a phone and a browser set to the same accent look like the same
/// product. Each carries both schemes, because lime is unreadable on paper and
/// a deep green is invisible on black.
enum Accent {
  signal(
    label: 'Signal',
    note: 'Lime on black, deep green on paper',
    light: Color(0xFF2C6B27),
    lightInk: Color(0xFFFFFFFF),
    lightWash: Color(0xFFE9F2E5),
    dark: Color(0xFFC8F04C),
    darkInk: Color(0xFF0D1007),
    darkWash: Color(0xFF1A220F),
  ),
  ion(
    label: 'Ion',
    note: 'Cold cyan',
    light: Color(0xFF0F6B78),
    lightInk: Color(0xFFFFFFFF),
    lightWash: Color(0xFFE0F0F2),
    dark: Color(0xFF5FE3F0),
    darkInk: Color(0xFF04171A),
    darkWash: Color(0xFF0E2225),
  ),
  ember(
    label: 'Ember',
    note: 'Warm amber',
    light: Color(0xFF9A4A06),
    lightInk: Color(0xFFFFFFFF),
    lightWash: Color(0xFFFCECE0),
    dark: Color(0xFFFFA552),
    darkInk: Color(0xFF2A1403),
    darkWash: Color(0xFF2A1A0C),
  ),
  violet(
    label: 'Violet',
    note: 'Soft lavender',
    light: Color(0xFF5B3BA8),
    lightInk: Color(0xFFFFFFFF),
    lightWash: Color(0xFFEEE9FB),
    dark: Color(0xFFC3A6FF),
    darkInk: Color(0xFF170B2E),
    darkWash: Color(0xFF1C1430),
  ),

  /// No accent at all: the instrument in monochrome. Everything still reads,
  /// which is the test that the layout was never carrying colour.
  bone(
    label: 'Bone',
    note: 'No accent at all',
    light: Color(0xFF3A3A3C),
    lightInk: Color(0xFFFFFFFF),
    lightWash: Color(0xFFEBEAE7),
    dark: Color(0xFFE8E4DA),
    darkInk: Color(0xFF17181A),
    darkWash: Color(0xFF232426),
  );

  const Accent({
    required this.label,
    required this.note,
    required this.light,
    required this.lightInk,
    required this.lightWash,
    required this.dark,
    required this.darkInk,
    required this.darkWash,
  });

  final String label;
  final String note;
  final Color light, lightInk, lightWash;
  final Color dark, darkInk, darkWash;

  /// The swatch to preview this accent with, in the scheme actually in force.
  Color swatch(Brightness brightness) =>
      brightness == Brightness.dark ? dark : light;

  static Accent byName(String? name) => Accent.values.firstWhere(
    (a) => a.name == name,
    orElse: () => Accent.signal,
  );
}

/// Same identity as the web client: one signal colour reserved for things
/// that are actually happening, ink on a quiet ground, and monospace for
/// anything the machine measured.
///
/// Carried as a [ThemeExtension] rather than as top-level constants, because
/// there is a palette per scheme and per accent. Widgets read
/// `Palette.of(context)` and neither know nor care which is in force.
@immutable
class Palette extends ThemeExtension<Palette> {
  final Color ground;
  final Color groundDeep;
  final Color panel;
  final Color panelSoft;
  final Color line;
  final Color lineStrong;
  final Color ink;
  final Color inkSoft;
  final Color inkFaint;
  final Color signal;
  final Color signalInk;
  final Color signalWash;
  final Color danger;
  final Color dangerWash;
  final Color warn;
  final Color warnWash;

  const Palette({
    required this.ground,
    required this.groundDeep,
    required this.panel,
    required this.panelSoft,
    required this.line,
    required this.lineStrong,
    required this.ink,
    required this.inkSoft,
    required this.inkFaint,
    required this.signal,
    required this.signalInk,
    required this.signalWash,
    required this.danger,
    required this.dangerWash,
    required this.warn,
    required this.warnWash,
  });

  static const _darkBase = Palette(
    ground: Color(0xFF08090B),
    groundDeep: Color(0xFF050608),
    panel: Color(0xFF101216),
    panelSoft: Color(0xFF14171C),
    line: Color(0xFF22262C),
    lineStrong: Color(0xFF2F343C),
    ink: Color(0xFFF2F3F1),
    inkSoft: Color(0xFF9BA1A8),
    inkFaint: Color(0xFF676D75),
    signal: Color(0xFFC8F04C),
    signalInk: Color(0xFF0D1007),
    signalWash: Color(0xFF1A220F),
    danger: Color(0xFFFF8A75),
    dangerWash: Color(0xFF2B1613),
    warn: Color(0xFFF0C274),
    warnWash: Color(0xFF2A2011),
  );

  static const _lightBase = Palette(
    ground: Color(0xFFF6F5F2),
    groundDeep: Color(0xFFEEECE7),
    panel: Color(0xFFFFFFFF),
    panelSoft: Color(0xFFFBFAF8),
    line: Color(0xFFE3E0DA),
    lineStrong: Color(0xFFD2CEC6),
    ink: Color(0xFF14161A),
    inkSoft: Color(0xFF565961),
    inkFaint: Color(0xFF8B8E96),
    signal: Color(0xFF2C6B27),
    signalInk: Color(0xFFFFFFFF),
    signalWash: Color(0xFFE9F2E5),
    danger: Color(0xFFA2301C),
    dangerWash: Color(0xFFFBEBE9),
    warn: Color(0xFF8A5A08),
    warnWash: Color(0xFFFDF3E0),
  );

  /// The neutrals for a scheme, with an accent laid over them.
  static Palette forTheme(Brightness brightness, Accent accent) {
    final base = brightness == Brightness.dark ? _darkBase : _lightBase;
    return base._withAccent(
      brightness == Brightness.dark ? accent.dark : accent.light,
      brightness == Brightness.dark ? accent.darkInk : accent.lightInk,
      brightness == Brightness.dark ? accent.darkWash : accent.lightWash,
    );
  }

  /// The palette in force. Falls back to the default dark one rather than
  /// throwing, so a widget rendered outside the app's theme still draws
  /// something sane.
  static Palette of(BuildContext context) =>
      Theme.of(context).extension<Palette>() ??
      forTheme(Brightness.dark, Accent.signal);

  Palette _withAccent(Color signal, Color signalInk, Color signalWash) =>
      Palette(
        ground: ground,
        groundDeep: groundDeep,
        panel: panel,
        panelSoft: panelSoft,
        line: line,
        lineStrong: lineStrong,
        ink: ink,
        inkSoft: inkSoft,
        inkFaint: inkFaint,
        signal: signal,
        signalInk: signalInk,
        signalWash: signalWash,
        danger: danger,
        dangerWash: dangerWash,
        warn: warn,
        warnWash: warnWash,
      );

  @override
  Palette copyWith() => this;

  @override
  Palette lerp(ThemeExtension<Palette>? other, double t) {
    if (other is! Palette) return this;
    // Whole-palette interpolation, so switching theme animates rather than
    // snapping halfway through a transfer.
    Color c(Color a, Color b) => Color.lerp(a, b, t)!;
    return Palette(
      ground: c(ground, other.ground),
      groundDeep: c(groundDeep, other.groundDeep),
      panel: c(panel, other.panel),
      panelSoft: c(panelSoft, other.panelSoft),
      line: c(line, other.line),
      lineStrong: c(lineStrong, other.lineStrong),
      ink: c(ink, other.ink),
      inkSoft: c(inkSoft, other.inkSoft),
      inkFaint: c(inkFaint, other.inkFaint),
      signal: c(signal, other.signal),
      signalInk: c(signalInk, other.signalInk),
      signalWash: c(signalWash, other.signalWash),
      danger: c(danger, other.danger),
      dangerWash: c(dangerWash, other.dangerWash),
      warn: c(warn, other.warn),
      warnWash: c(warnWash, other.warnWash),
    );
  }
}

ThemeData buildTheme(Brightness brightness, Accent accent) {
  final p = Palette.forTheme(brightness, accent);
  final base = ThemeData(brightness: brightness, useMaterial3: true);

  return base.copyWith(
    scaffoldBackgroundColor: p.ground,
    extensions: [p],
    colorScheme: base.colorScheme.copyWith(
      primary: p.signal,
      onPrimary: p.signalInk,
      surface: p.panel,
      onSurface: p.ink,
      error: p.danger,
    ),
    textTheme: base.textTheme.apply(bodyColor: p.ink, displayColor: p.ink),
    dividerTheme: DividerThemeData(color: p.line, space: 1, thickness: 1),
    appBarTheme: AppBarTheme(
      backgroundColor: p.ground,
      foregroundColor: p.ink,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      centerTitle: false,
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: p.panel,
      contentTextStyle: TextStyle(color: p.ink, fontSize: 13.5),
      behavior: SnackBarBehavior.floating,
    ),
    // Pills, matching the web client's primary actions. A fully rounded button
    // reads as "press me" at arm's length in a way a 14px radius does not, and
    // the two clients are meant to look like one product.
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: p.signal,
        foregroundColor: p.signalInk,
        minimumSize: const Size.fromHeight(54),
        shape: const StadiumBorder(),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: p.ink,
        side: BorderSide(color: p.line),
        minimumSize: const Size.fromHeight(54),
        shape: const StadiumBorder(),
        textStyle: const TextStyle(fontSize: 16),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: p.inkSoft),
    ),
  );
}

/// Anything the machine measured — sizes, rates, links.
const tabular = TextStyle(
  fontFamily: 'monospace',
  fontFeatures: [FontFeature.tabularFigures()],
);
