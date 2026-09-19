import 'package:flutter/material.dart';

/// Same identity as the web client: near-black ground, one signal colour
/// reserved for things that are actually happening, monospace for anything
/// the machine measured.
abstract final class Palette {
  static const ground = Color(0xFF08090B);
  static const groundDeep = Color(0xFF050608);
  static const panel = Color(0xFF101216);
  static const panelSoft = Color(0xFF14171C);
  static const line = Color(0xFF22262C);
  static const lineStrong = Color(0xFF2F343C);
  static const ink = Color(0xFFF2F3F1);
  static const inkSoft = Color(0xFF9BA1A8);
  static const inkFaint = Color(0xFF676D75);
  static const signal = Color(0xFFC8F04C);
  static const signalInk = Color(0xFF0D1007);
  static const signalWash = Color(0xFF1A220F);
  static const danger = Color(0xFFFF8A75);
  static const dangerWash = Color(0xFF2B1613);
}

ThemeData buildTheme() {
  final base = ThemeData.dark(useMaterial3: true);

  return base.copyWith(
    scaffoldBackgroundColor: Palette.ground,
    colorScheme: base.colorScheme.copyWith(
      primary: Palette.signal,
      onPrimary: Palette.signalInk,
      surface: Palette.panel,
      onSurface: Palette.ink,
      error: Palette.danger,
    ),
    textTheme: base.textTheme.apply(
      bodyColor: Palette.ink,
      displayColor: Palette.ink,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: Palette.ground,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      centerTitle: false,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Palette.signal,
        foregroundColor: Palette.signalInk,
        minimumSize: const Size.fromHeight(54),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: Palette.ink,
        side: const BorderSide(color: Palette.line),
        minimumSize: const Size.fromHeight(54),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 16),
      ),
    ),
  );
}

/// Anything the machine measured — sizes, rates, links.
const tabular = TextStyle(
  fontFamily: 'monospace',
  fontFeatures: [FontFeature.tabularFigures()],
);
