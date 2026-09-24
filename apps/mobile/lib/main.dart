import 'package:direct_protocol/direct_protocol.dart';
import 'dart:async';
import 'dart:io';

import 'package:app_links/app_links.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:path_provider/path_provider.dart';

import 'history_page.dart';
import 'store.dart';
import 'theme.dart';
import 'theme_sheet.dart';
import 'transfer/background.dart';
import 'transfer/peer.dart';

import 'transfer/receiver.dart';
import 'transfer/sender.dart';
import 'transfer/signaling.dart';
import 'widgets.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  TransferService.init();
  // Read the saved theme before the first frame, so the app never flashes the
  // wrong one on launch.
  await Store.instance.load();
  runApp(const DirectApp());
}

class DirectApp extends StatelessWidget {
  const DirectApp({super.key});

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Store.instance.look,
    builder: (_, _) {
      final accent = Store.instance.accent.value;
      return MaterialApp(
        title: 'Direct',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(Brightness.light, accent),
        darkTheme: buildTheme(Brightness.dark, accent),
        themeMode: Store.instance.themeMode.value,
        // Every surface changes colour at once, and an instant swap reads as
        // a flicker rather than as a choice taking effect.
        themeAnimationDuration: const Duration(milliseconds: 220),
        themeAnimationCurve: Curves.easeOut,
        home: const HomePage(),
      );
    },
  );
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  FileSender? _sender;
  SenderSnapshot? _send;

  FileReceiver? _receiver;
  ReceiverSnapshot? _receive;

  /// Chosen but not yet sent. A batch is assembled before it is committed.
  final List<PickedFile> _staged = [];
  final _noteController = TextEditingController();
  final _linkController = TextEditingController();

  /// Android may copy the chosen files out of shared storage before handing
  /// them over, which for a large video takes real time and shows nothing.
  bool _picking = false;

  /// One history entry per transfer, written the moment it settles.
  bool _logged = false;

  /// Share links arriving as intents — the manifest claims /t/ URLs on the
  /// web client's host, so tapping one in a chat app lands here.
  StreamSubscription<Uri>? _links;

  @override
  void initState() {
    super.initState();
    unawaited(TransferService.requestPermissions());

    // The stream replays the link the app was launched with, so this covers
    // both a cold start from a tapped link and one arriving while the app is
    // already open.
    _links = AppLinks().uriLinkStream.listen(_followLink);

    // Start waking the signaling service now, so its cold start overlaps with
    // choosing a file rather than landing on the user afterwards.
    warmUp();
  }

  @override
  void dispose() {
    unawaited(_links?.cancel());
    _sender?.cancel();
    _receiver?.cancel();
    _noteController.dispose();
    _linkController.dispose();
    unawaited(TransferService.stop());
    super.dispose();
  }

  /* --------------------------------------------------------------- choose */

  Future<void> _pickFiles() async {
    setState(() => _picking = true);
    List<PlatformFile> picked;
    try {
      // v13 returns a list and no longer exposes a platform instance.
      picked = await FilePicker.pickFiles();
    } finally {
      if (mounted) setState(() => _picking = false);
    }
    // length() is async and may have to read the file: native pickers usually
    // report the size, but not always, and the staged list needs a number it
    // can render without touching the disk again.
    final staged = <PickedFile>[];
    for (final f in picked) {
      final path = f.path;
      if (path == null) continue;
      staged.add(
        PickedFile(
          file: File(path),
          name: f.name,
          size: await f.length() ?? 0,
        ),
      );
    }
    _stage(staged);
  }

  Future<void> _pickFolder() async {
    setState(() => _picking = true);
    String? root;
    try {
      root = await FilePicker.getDirectoryPath();
    } finally {
      if (mounted) setState(() => _picking = false);
    }
    if (root == null) return;

    final dir = Directory(root);
    final base = dir.path.split(Platform.pathSeparator).last;
    final found = <PickedFile>[];

    try {
      await for (final entity in dir.list(recursive: true, followLinks: false)) {
        if (entity is! File) continue;
        if (found.length >= maxFilesPerTransfer) break;

        // The path the receiver recreates, relative to the folder chosen —
        // with the folder itself kept, so a batch does not spill loose files
        // into whatever directory they pick on the other side.
        final relative = entity.path.substring(dir.path.length + 1);
        final parts = relative.split(Platform.pathSeparator);
        found.add(
          PickedFile(
            file: entity,
            name: parts.last,
            size: await entity.length(),
            path: [base, ...parts.sublist(0, parts.length - 1)].join('/'),
          ),
        );
      }
    } catch (_) {
      _toast('Could not read that folder.');
      return;
    }

    if (found.isEmpty) {
      _toast('That folder has no files in it.');
      return;
    }
    _stage(found);
  }

  void _stage(List<PickedFile> incoming) {
    if (incoming.isEmpty) return;
    setState(() {
      // Picking the same file twice is a slip, not an instruction to send it
      // twice.
      final seen = _staged.map((p) => p.file.path).toSet();
      for (final p in incoming) {
        if (seen.add(p.file.path) && _staged.length < maxFilesPerTransfer) {
          _staged.add(p);
        }
      }
    });
  }

  /* ----------------------------------------------------------------- send */

  Future<void> _send0() async {
    if (_staged.isEmpty) return;
    _logged = false;

    final sender = FileSender(
      picked: List.of(_staged),
      note: _noteController.text,
      onChange: _onSenderChange,
    );
    setState(() {
      _sender = sender;
      _send = null;
    });
    await sender.start();
  }

  void _onSenderChange(SenderSnapshot s) {
    if (!mounted) return;
    setState(() => _send = s);

    // The foreground service has to start the moment there is a link, not
    // when bytes start moving: the very next thing the user does is leave for
    // a messaging app to send that link, and without the service Android
    // freezes us and the session dies before anyone can open it.
    switch (s.state) {
      case TransferState.waiting:
      case TransferState.connecting:
      case TransferState.offering:
        unawaited(
          TransferService.start(
            title: 'Ready to send ${countFiles(s.files.length)}',
            body: 'Waiting for them to open the link. Keep this running.',
          ),
        );
      case TransferState.transferring:
      case TransferState.verifying:
        unawaited(
          TransferService.start(
            title: 'Sending ${s.label}',
            body: _serviceLine(s.progress),
          ),
        );
      case TransferState.complete:
      case TransferState.failed:
      case TransferState.declined:
        unawaited(TransferService.stop());
        _log(
          sent: true,
          label: s.label,
          fileCount: s.files.length,
          bytes: s.totalBytes,
          state: s.state,
          seconds: s.progress.elapsedSeconds,
        );
      default:
        break;
    }
  }

  /* -------------------------------------------------------------- receive */

  /// A share link tapped somewhere else on the phone.
  ///
  /// Refused while something is already in flight: silently replacing a live
  /// transfer with a new one loses the first without saying so.
  void _followLink(Uri uri) {
    if (_sender != null || _receiver != null) {
      _toast('Finish or cancel the current transfer before opening another.');
      return;
    }
    _linkController.text = uri.toString();
    unawaited(_openLink());
  }

  Future<void> _openLink() async {
    final parsed = parseShareUrl(_linkController.text);
    if (parsed == null) {
      _toast(
        'That does not look like a transfer link. Paste the whole thing, '
        'including the part after the #.',
      );
      return;
    }
    _logged = false;

    final receiver = FileReceiver(
      sessionId: parsed.sessionId,
      token: parsed.token,
      chooseDestination: _destinationFor,
      onChange: _onReceiverChange,
    );
    setState(() {
      _receiver = receiver;
      _receive = null;
    });
    await receiver.start();
  }

  /// Where a received batch lands.
  ///
  /// Downloads if the platform exposes it, otherwise app documents. The
  /// receiver creates subdirectories and resolves name collisions inside it.
  Future<String> _destinationFor(Manifest manifest) async {
    Directory dir;
    try {
      dir =
          await getDownloadsDirectory() ??
          await getApplicationDocumentsDirectory();
    } catch (_) {
      dir = await getApplicationDocumentsDirectory();
    }
    return dir.path;
  }

  void _onReceiverChange(ReceiverSnapshot s) {
    if (!mounted) return;
    setState(() => _receive = s);

    switch (s.state) {
      case TransferState.waiting:
      case TransferState.offered:
        unawaited(
          TransferService.start(
            title: 'Incoming transfer',
            body: 'Connected to the sender. Keep this running.',
          ),
        );
      case TransferState.transferring:
      case TransferState.verifying:
        unawaited(
          TransferService.start(
            title: 'Receiving ${s.manifest?.files.first.name ?? 'files'}',
            body: _serviceLine(s.progress),
          ),
        );
      case TransferState.complete:
      case TransferState.failed:
      case TransferState.declined:
      case TransferState.peerGone:
      case TransferState.expired:
        unawaited(TransferService.stop());
        _log(
          sent: false,
          label: s.manifest?.files.first.name ?? 'transfer',
          fileCount: s.manifest?.files.length ?? 1,
          bytes: s.manifest?.totalBytes ?? 0,
          state: s.state,
          seconds: s.progress.elapsedSeconds,
        );
      default:
        break;
    }
  }

  void _log({
    required bool sent,
    required String label,
    required int fileCount,
    required int bytes,
    required TransferState state,
    required double seconds,
  }) {
    if (_logged) return;
    _logged = true;
    Store.instance.record(
      HistoryItem(
        at: DateTime.now().millisecondsSinceEpoch,
        sent: sent,
        label: label,
        fileCount: fileCount,
        bytes: bytes,
        outcome: switch (state) {
          TransferState.complete => 'complete',
          TransferState.declined => 'declined',
          _ => 'failed',
        },
        seconds: seconds > 0 ? seconds : null,
      ),
    );
  }

  String _serviceLine(Progress p) =>
      '${(p.fraction * 100).toStringAsFixed(0)}% · ${formatBytes(p.transferred)} '
      'of ${formatBytes(p.total)} · ${formatRate(p.bytesPerSecond)}';

  /* ---------------------------------------------------------------- misc */

  void _copyLink(String url) {
    unawaited(Clipboard.setData(ClipboardData(text: url)));
    _toast(
      'Link copied. Send it however you like — the whole thing, including '
      'the part after the #.',
    );
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _reset() {
    _sender?.cancel();
    _receiver?.cancel();
    unawaited(TransferService.stop());
    setState(() {
      _sender = null;
      _send = null;
      _receiver = null;
      _receive = null;
      _staged.clear();
      _noteController.clear();
      _linkController.clear();
    });
  }

  /* ---------------------------------------------------------------- view */

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final busy = _send != null || _receive != null;

    return WithForegroundTask(
      child: Scaffold(
        appBar: AppBar(
          titleSpacing: 18,
          title: Row(
            children: [
              const _Mark(),
              const SizedBox(width: 10),
              const Text(
                'Direct',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
              ),
              const Spacer(),
              if (busy)
                TextButton(onPressed: _reset, child: const Text('Reset'))
              else
                IconButton(
                  tooltip: 'Recent transfers',
                  color: p.inkSoft,
                  icon: const Icon(Icons.history, size: 20),
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const HistoryPage(),
                    ),
                  ),
                ),
              const ThemeButton(),
            ],
          ),
        ),
        body: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 32),
            child: _body(),
          ),
        ),
      ),
    );
  }

  Widget _body() {
    if (_send != null) {
      return _SenderView(
        snap: _send!,
        onCancel: _reset,
        onCopy: _copyLink,
        onPause: () => _sender?.pause(),
        onResume: () => _sender?.resume(),
      );
    }
    if (_receive != null) {
      return _ReceiverView(
        snap: _receive!,
        onAccept: () => unawaited(_receiver!.accept()),
        onDecline: () => _receiver!.decline(),
      );
    }
    return _idle();
  }

  Widget _idle() {
    final p = Palette.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 12),
        const Text(
          'Send files straight\nto another device.',
          style: TextStyle(
            fontSize: 30,
            height: 1.1,
            fontWeight: FontWeight.w600,
            letterSpacing: -0.8,
          ),
        ),
        const SizedBox(height: 14),
        Text(
          'Nothing uploads. The files go directly between the two devices, '
          'and they keep going while this app is in the background.',
          style: TextStyle(fontSize: 15, height: 1.55, color: p.inkSoft),
        ),
        const SizedBox(height: 28),

        Panel(
          child: _staged.isEmpty ? _emptyPicker() : _stagedBatch(),
        ),

        const SizedBox(height: 22),
        Row(
          children: [
            Expanded(child: Divider(color: p.line)),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Text(
                'OR RECEIVE',
                style: TextStyle(
                  fontSize: 10.5,
                  color: p.inkFaint,
                  letterSpacing: 1.4,
                ),
              ),
            ),
            Expanded(child: Divider(color: p.line)),
          ],
        ),
        const SizedBox(height: 22),

        Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Paste a transfer link',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _linkController,
                style: tabular.copyWith(fontSize: 12.5, color: p.ink),
                maxLines: 2,
                minLines: 1,
                decoration: InputDecoration(
                  hintText: 'https://…/t/…#token=…',
                  hintStyle: TextStyle(color: p.inkFaint, fontSize: 12.5),
                  filled: true,
                  fillColor: p.panelSoft,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: BorderSide(color: p.line),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: BorderSide(color: p.line),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => unawaited(_openLink()),
                      child: const Text('Open link'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  IconButton.outlined(
                    tooltip: 'Paste',
                    onPressed: () async {
                      final data = await Clipboard.getData('text/plain');
                      if (data?.text != null) {
                        _linkController.text = data!.text!.trim();
                      }
                    },
                    icon: const Icon(Icons.content_paste, size: 18),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                'The whole link matters, including the part after the #. That '
                'is the key to the transfer, and some chat apps trim it.',
                style: TextStyle(fontSize: 12, height: 1.5, color: p.inkFaint),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _emptyPicker() {
    final p = Palette.of(context);
    return Column(
      children: [
        const Endpoints(from: 'This phone', to: 'Them'),
        const SizedBox(height: 22),
        if (_picking)
          const Working(
            label: 'Opening…',
            patience:
                'Android copies large files out of shared storage before '
                'handing them over, which can take a while for a video.',
          )
        else ...[
          FilledButton(
            onPressed: () => unawaited(_pickFiles()),
            child: const Text('Choose files'),
          ),
          const SizedBox(height: 10),
          OutlinedButton(
            onPressed: () => unawaited(_pickFolder()),
            child: const Text('Choose a folder'),
          ),
        ],
        const SizedBox(height: 10),
        Text(
          'up to ${formatBytes(maxTransferBytes)} per transfer',
          style: TextStyle(fontSize: 12.5, color: p.inkFaint),
        ),
      ],
    );
  }

  Widget _stagedBatch() {
    final p = Palette.of(context);
    final total = _staged.fold<int>(0, (sum, f) => sum + f.size);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: Text(
                '${countFiles(_staged.length)} ready',
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            Text(
              formatBytes(total),
              style: tabular.copyWith(fontSize: 13, color: p.inkSoft),
            ),
          ],
        ),
        const SizedBox(height: 14),
        FileQueue(
          rows: [
            for (final f in _staged)
              QueueRow(
                name: f.name,
                path: f.path,
                size: f.size,
                transferred: 0,
                state: RowState.queued,
              ),
          ],
          onRemove: (i) => setState(() => _staged.removeAt(i)),
        ),
        const SizedBox(height: 14),
        TextField(
          controller: _noteController,
          maxLines: 2,
          minLines: 1,
          maxLength: 2000,
          style: TextStyle(fontSize: 13.5, color: p.ink),
          decoration: InputDecoration(
            hintText: 'Add a note for them (optional)',
            hintStyle: TextStyle(color: p.inkFaint, fontSize: 13),
            counterText: '',
            filled: true,
            fillColor: p.panelSoft,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: BorderSide(color: p.line),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: BorderSide(color: p.line),
            ),
          ),
        ),
        const SizedBox(height: 6),
        if (total > maxTransferBytes) ...[
          Notice(
            'That is ${formatBytes(total)} in total, over the '
            '${formatBytes(maxTransferBytes)} ceiling. Remove something, or '
            'send it in two goes.',
            tone: NoticeTone.error,
          ),
          const SizedBox(height: 12),
        ],
        FilledButton(
          onPressed: total > maxTransferBytes
              ? null
              : () => unawaited(_send0()),
          child: const Text('Create the link'),
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: () => unawaited(_pickFiles()),
                child: const Text('Add more'),
              ),
            ),
            const SizedBox(width: 10),
            TextButton(
              onPressed: () => setState(_staged.clear),
              child: const Text('Clear'),
            ),
          ],
        ),
      ],
    );
  }
}

/* ------------------------------------------------------------------ views */

class _SenderView extends StatelessWidget {
  final SenderSnapshot snap;
  final VoidCallback onCancel;
  final VoidCallback onPause;
  final VoidCallback onResume;
  final void Function(String url) onCopy;

  const _SenderView({
    required this.snap,
    required this.onCancel,
    required this.onCopy,
    required this.onPause,
    required this.onResume,
  });

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final moving =
        snap.state == TransferState.transferring ||
        snap.state == TransferState.verifying;
    final sharing =
        snap.shareUrl != null &&
        (snap.state == TransferState.waiting ||
            snap.state == TransferState.connecting ||
            snap.state == TransferState.offering);

    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          BatchLine(
            name: snap.label,
            others: snap.files.length - 1,
            totalBytes: snap.totalBytes,
          ),
          const SizedBox(height: 20),
          Endpoints(
            from: 'This phone',
            to: 'Them',
            live: moving && !snap.paused,
            done: snap.state == TransferState.complete,
            error: snap.state == TransferState.failed,
          ),
          const SizedBox(height: 22),

          if (snap.state == TransferState.creating)
            const Working(
              label: 'Creating a transfer session…',
              patience:
                  'Taking longer than usual — the transfer service sleeps when '
                  'unused and is waking up. This only happens on the first '
                  'transfer after a quiet spell.',
            ),

          if (sharing) ...[
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: p.panelSoft,
                border: Border.all(color: p.line),
                borderRadius: BorderRadius.circular(12),
              ),
              child: SelectableText(
                snap.shareUrl!,
                style: tabular.copyWith(
                  fontSize: 11.5,
                  color: p.inkSoft,
                  height: 1.5,
                ),
              ),
            ),
            const SizedBox(height: 12),
            // Clipboard rather than a share sheet: one fewer plugin, and the
            // link still goes wherever the user wants it.
            FilledButton.icon(
              onPressed: () => onCopy(snap.shareUrl!),
              icon: const Icon(Icons.content_copy, size: 18),
              label: const Text('Copy the link'),
            ),
            const SizedBox(height: 16),
            Center(child: QrCard(url: snap.shareUrl!)),
            const SizedBox(height: 10),
            Text(
              'Or let them scan this. The code carries the whole link, '
              'including the key after the #.',
              style: TextStyle(fontSize: 12, height: 1.5, color: p.inkFaint),
            ),
            const SizedBox(height: 14),
            if (snap.state == TransferState.connecting)
              const Working(
                label: 'They opened the link. Making a direct connection…',
                patience:
                    'Still trying. Some networks block direct connections '
                    'between devices — if it does not settle, one of you may '
                    'need a different network.',
              )
            else
              Notice(switch (snap.state) {
                TransferState.waiting =>
                  'Go and send the link — the transfer keeps running in the '
                      'background while you are in another app. Just do not '
                      'close this one: the files are sent from this phone.',
                _ =>
                  'Connected. Waiting for them to accept '
                      '${countFiles(snap.files.length)}.',
              }),
          ],

          if (moving) ...[
            ProgressReadout(
              progress: snap.progress,
              paused: snap.paused,
              label: snap.paused
                  ? 'Paused — the connection is still open'
                  : snap.state == TransferState.verifying
                  ? 'Sent — waiting for them to finish saving…'
                  : 'Sending ${snap.current >= 0 ? snap.files[snap.current].entry.name : ''}',
            ),
            const SizedBox(height: 14),
            const Notice(
              'You can leave the app. The transfer keeps running and shows '
              'progress in your notifications.',
            ),
            const SizedBox(height: 14),
            OutlinedButton(
              onPressed: snap.paused ? onResume : onPause,
              child: Text(snap.paused ? 'Resume' : 'Pause'),
            ),
          ],

          if (snap.files.length > 1) ...[
            const SizedBox(height: 14),
            FileQueue(rows: _rowsOf(snap)),
          ],

          if (snap.state == TransferState.complete) ...[
            const SizedBox(height: 14),
            Notice(
              'Sent and verified. ${countFiles(snap.files.length)} reached '
              'their device intact.',
              tone: NoticeTone.good,
            ),
          ],

          if (snap.state == TransferState.declined) ...[
            const SizedBox(height: 14),
            const Notice('They declined the transfer.'),
          ],
          if (snap.state == TransferState.failed) ...[
            const SizedBox(height: 14),
            Notice(
              snap.error ?? 'The transfer failed.',
              tone: NoticeTone.error,
            ),
          ],

          const SizedBox(height: 18),
          OutlinedButton(
            onPressed: onCancel,
            child: Text(moving ? 'Cancel transfer' : 'Start over'),
          ),
        ],
      ),
    );
  }

  List<QueueRow> _rowsOf(SenderSnapshot s) => [
    for (final f in s.files)
      QueueRow(
        name: f.entry.name,
        path: f.entry.path,
        size: f.entry.size,
        transferred: f.transferred,
        state: switch (f.state) {
          FileState.queued => RowState.queued,
          FileState.sending => RowState.active,
          FileState.failed => RowState.failed,
          _ => RowState.done,
        },
      ),
  ];
}

class _ReceiverView extends StatelessWidget {
  final ReceiverSnapshot snap;
  final VoidCallback onAccept;
  final VoidCallback onDecline;

  const _ReceiverView({
    required this.snap,
    required this.onAccept,
    required this.onDecline,
  });

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final manifest = snap.manifest;
    final moving =
        snap.state == TransferState.transferring ||
        snap.state == TransferState.verifying;

    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (manifest != null)
            BatchLine(
              name: manifest.files.first.name,
              others: manifest.files.length - 1,
              totalBytes: manifest.totalBytes,
            )
          else
            Text(
              'Incoming transfer',
              style: TextStyle(fontSize: 15, color: p.inkSoft),
            ),
          const SizedBox(height: 20),
          Endpoints(
            from: 'Them',
            to: 'This phone',
            live: moving,
            done: snap.state == TransferState.complete,
            error:
                snap.state == TransferState.failed ||
                snap.state == TransferState.expired ||
                snap.state == TransferState.peerGone,
          ),
          const SizedBox(height: 22),

          if (snap.state == TransferState.connecting ||
              snap.state == TransferState.waiting)
            const Working(
              label: 'Connecting to the sender…',
              patience:
                  'Taking a while. The transfer service may be waking up, or '
                  'the sender may have closed their app.',
            ),

          if (snap.state == TransferState.offered && manifest != null) ...[
            if (manifest.note.isNotEmpty) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                decoration: BoxDecoration(
                  color: p.panelSoft,
                  border: Border(left: BorderSide(color: p.signal, width: 2)),
                  borderRadius: const BorderRadius.horizontal(
                    right: Radius.circular(12),
                  ),
                ),
                child: Text(
                  manifest.note,
                  style: TextStyle(
                    fontSize: 13.5,
                    height: 1.5,
                    color: p.inkSoft,
                  ),
                ),
              ),
              const SizedBox(height: 14),
            ],
            Notice(
              '${countFiles(manifest.files.length)} — '
              // Not the shared Downloads folder: the destination is this app's
              // own storage, and the completed screen prints the real path.
              '${formatBytes(manifest.totalBytes)} — transfer directly from '
              "their device. They will be saved to this app's downloads.",
            ),
            const SizedBox(height: 14),
            if (manifest.files.length > 1) ...[
              FileQueue(rows: _rowsOf(snap)),
              const SizedBox(height: 14),
            ],
            FilledButton(
              onPressed: onAccept,
              child: const Text('Accept and save'),
            ),
            const SizedBox(height: 10),
            OutlinedButton(onPressed: onDecline, child: const Text('Decline')),
          ],

          if (moving) ...[
            ProgressReadout(
              progress: snap.progress,
              label: snap.state == TransferState.verifying
                  ? 'Saving and verifying…'
                  : 'Receiving ${snap.current >= 0 && snap.current < snap.files.length ? snap.files[snap.current].entry.name : ''}',
            ),
            const SizedBox(height: 14),
            const Notice(
              'You can leave the app. The transfer keeps running and shows '
              'progress in your notifications.',
            ),
            if (snap.files.length > 1) ...[
              const SizedBox(height: 14),
              FileQueue(rows: _rowsOf(snap)),
            ],
          ],

          if (snap.state == TransferState.complete) ...[
            Notice(
              'Transfer complete. ${countFiles(snap.files.length)} verified '
              "against the sender's checksums.",
              tone: NoticeTone.good,
            ),
            if (snap.savedTo != null) ...[
              const SizedBox(height: 10),
              Text(
                'Saved to ${snap.savedTo}',
                style: tabular.copyWith(fontSize: 11.5, color: p.inkFaint),
              ),
            ],
          ],

          if (snap.state == TransferState.declined)
            const Notice('You declined the transfer.'),
          if (snap.state == TransferState.expired ||
              snap.state == TransferState.peerGone ||
              snap.state == TransferState.failed)
            Notice(
              snap.error ?? 'The transfer failed.',
              tone: NoticeTone.error,
            ),
        ],
      ),
    );
  }

  List<QueueRow> _rowsOf(ReceiverSnapshot s) => [
    for (final f in s.files)
      QueueRow(
        name: f.entry.name,
        path: f.entry.path,
        size: f.entry.size,
        transferred: f.transferred,
        state: switch (f.state) {
          IncomingState.queued => RowState.queued,
          IncomingState.receiving => RowState.active,
          IncomingState.failed => RowState.failed,
          IncomingState.verified => RowState.done,
        },
      ),
  ];
}

class _Mark extends StatelessWidget {
  const _Mark();

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 22,
    height: 22,
    child: CustomPaint(painter: _MarkPainter(Palette.of(context))),
  );
}

class _MarkPainter extends CustomPainter {
  final Palette palette;
  _MarkPainter(this.palette);

  @override
  void paint(Canvas canvas, Size size) {
    final y = size.height / 2;
    canvas.drawCircle(Offset(4, y), 3, Paint()..color = palette.ink);
    canvas.drawLine(
      Offset(9, y),
      Offset(14, y),
      Paint()
        ..color = palette.signal
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round,
    );
    canvas.drawCircle(
      Offset(18, y),
      3,
      Paint()
        ..color = palette.ink
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
  }

  @override
  bool shouldRepaint(_MarkPainter old) => old.palette != palette;
}
