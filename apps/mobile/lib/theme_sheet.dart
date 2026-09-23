import 'package:flutter/material.dart';

import 'store.dart';
import 'theme.dart';

/// Scheme and accent, behind one control.
///
/// Two rows rather than one, because they answer different questions: how
/// bright the room is, and which colour the product spends. Mirrors the web
/// client's picker, down to the accent names, so the two feel like one product.
class ThemeButton extends StatelessWidget {
  const ThemeButton({super.key});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final brightness = Theme.of(context).brightness;

    return ListenableBuilder(
      listenable: Store.instance.look,
      builder: (context, _) {
        final mode = Store.instance.themeMode.value;
        return IconButton(
          tooltip: 'Theme',
          onPressed: () => _open(context),
          icon: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(_iconFor(mode), size: 20, color: p.inkSoft),
              const SizedBox(width: 6),
              Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(
                  color: Store.instance.accent.value.swatch(brightness),
                  shape: BoxShape.circle,
                  border: Border.all(color: p.lineStrong),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _open(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Palette.of(context).panel,
      showDragHandle: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      builder: (_) => const _ThemeSheet(),
    );
  }
}

IconData _iconFor(ThemeMode mode) => switch (mode) {
  ThemeMode.system => Icons.brightness_auto_outlined,
  ThemeMode.light => Icons.light_mode_outlined,
  ThemeMode.dark => Icons.dark_mode_outlined,
};

class _ThemeSheet extends StatelessWidget {
  const _ThemeSheet();

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final brightness = Theme.of(context).brightness;

    return SafeArea(
      child: ListenableBuilder(
        listenable: Store.instance.look,
        builder: (context, _) {
          final mode = Store.instance.themeMode.value;
          final accent = Store.instance.accent.value;

          return Padding(
            padding: const EdgeInsets.fromLTRB(18, 4, 18, 18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Legend('Appearance'),
                const SizedBox(height: 10),
                _SchemeRow(mode: mode),
                const SizedBox(height: 22),
                _Legend('Accent'),
                const SizedBox(height: 6),
                for (final option in Accent.values)
                  _AccentRow(
                    accent: option,
                    active: option == accent,
                    brightness: brightness,
                  ),
                const SizedBox(height: 14),
                Divider(color: p.line, height: 1),
                const SizedBox(height: 12),
                Text(
                  'Kept on this device. The accent is the only colour the '
                  'interface spends, so changing it changes nothing else.',
                  style: TextStyle(
                    fontSize: 11.5,
                    height: 1.5,
                    color: p.inkFaint,
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _Legend extends StatelessWidget {
  final String text;
  const _Legend(this.text);

  @override
  Widget build(BuildContext context) => Text(
    text.toUpperCase(),
    style: TextStyle(
      fontSize: 10.5,
      letterSpacing: 1.4,
      color: Palette.of(context).inkFaint,
    ),
  );
}

class _SchemeRow extends StatelessWidget {
  final ThemeMode mode;
  const _SchemeRow({required this.mode});

  static const _options = [
    (ThemeMode.light, 'Light'),
    (ThemeMode.system, 'Auto'),
    (ThemeMode.dark, 'Dark'),
  ];

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: p.panelSoft,
        border: Border.all(color: p.line),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          for (final (value, label) in _options)
            Expanded(
              child: GestureDetector(
                onTap: () => Store.instance.setTheme(value),
                behavior: HitTestBehavior.opaque,
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 180),
                  padding: const EdgeInsets.symmetric(vertical: 11),
                  decoration: BoxDecoration(
                    color: mode == value ? p.ground : Colors.transparent,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        _iconFor(value),
                        size: 15,
                        color: mode == value ? p.ink : p.inkFaint,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        label,
                        style: TextStyle(
                          fontSize: 13,
                          color: mode == value ? p.ink : p.inkFaint,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _AccentRow extends StatelessWidget {
  final Accent accent;
  final bool active;
  final Brightness brightness;

  const _AccentRow({
    required this.accent,
    required this.active,
    required this.brightness,
  });

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);

    return InkWell(
      onTap: () => Store.instance.setAccent(accent),
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
        decoration: BoxDecoration(
          color: active ? p.groundDeep : Colors.transparent,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Container(
              width: 22,
              height: 22,
              decoration: BoxDecoration(
                // Previewed in the scheme actually in force, so the row shows
                // what the choice would look like here rather than five
                // colours from a mode nobody is in.
                color: accent.swatch(brightness),
                shape: BoxShape.circle,
                border: Border.all(color: p.lineStrong),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    accent.label,
                    style: TextStyle(fontSize: 14, color: p.ink),
                  ),
                  Text(
                    accent.note,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11.5, color: p.inkFaint),
                  ),
                ],
              ),
            ),
            if (active) Icon(Icons.check, size: 17, color: p.signal),
          ],
        ),
      ),
    );
  }
}
