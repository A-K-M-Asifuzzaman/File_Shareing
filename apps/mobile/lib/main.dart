import 'package:direct_protocol/direct_protocol.dart';
import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:path_provider/path_provider.dart';

import 'theme.dart';
import 'transfer/background.dart';
import 'transfer/peer.dart';

import 'transfer/receiver.dart';
import 'transfer/sender.dart';
import 'transfer/signaling.dart';
import 'widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  TransferService.init();
  runApp(const DirectApp());
}

class DirectApp extends StatelessWidget {
  const DirectApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Direct',
    debugShowCheckedModeBanner: false,
    theme: buildTheme(),
    home: const HomePage(),
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

  final _linkController = TextEditingController();

  /// Android may copy the chosen file out of shared storage before handing it
  /// over, which for a large video takes real time and shows nothing.
  bool _picking = false;

  @override
  void initState() {
    super.initState();
    unawaited(TransferService.requestPermissions());

    // Start waking the signaling service now, so its cold start overlaps with
    // choosing a file rather than landing on the user afterwards.
    warmUp();
  }

  @override
  void dispose() {
    _sender?.cancel();
    _receiver?.cancel();
    _linkController.dispose();
    unawaited(TransferService.stop());
    super.dispose();
  }

  /* ---------------------------------------------------------------- send */

  Future<void> _pickAndSend() async {
    setState(() => _picking = true);

    List<PlatformFile> picked;
    try {
      // v13 returns a list and no longer exposes a platform instance.
      picked = await FilePicker.pickFiles();
    } finally {
      if (mounted) setState(() => _picking = false);
    }
    if (picked.isEmpty || picked.first.path == null) return;

    final chosen = picked.first;
    final file = File(chosen.path!);
    final sender = FileSender(
      file: file,
      displayName: chosen.name,
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
            title: 'Ready to send ${s.fileName}',
            body: 'Waiting for them to open the link. Keep this running.',
          ),
        );
      case TransferState.transferring:
      case TransferState.verifying:
        unawaited(
          TransferService.start(
            title: 'Sending ${s.fileName}',
            body: _serviceLine(s.progress),
          ),
        );
      case TransferState.complete:
      case TransferState.failed:
      case TransferState.declined:
        unawaited(TransferService.stop());
      default:
        break;
    }
  }

  /* ------------------------------------------------------------- receive */

  Future<void> _openLink() async {
    final parsed = parseShareUrl(_linkController.text);
    if (parsed == null) {
      _toast(
        'That does not look like a transfer link. Paste the whole thing, '
        'including the part after the #.',
      );
      return;
    }

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

  /// Where a received file lands.
  ///
  /// Downloads if the platform exposes it, otherwise app documents. A name
  /// that already exists is suffixed rather than overwritten — silently
  /// replacing someone's file would be worse than an awkward name.
  Future<String> _destinationFor(FileOffer offer) async {
    Directory dir;
    try {
      dir =
          await getDownloadsDirectory() ??
          await getApplicationDocumentsDirectory();
    } catch (_) {
      dir = await getApplicationDocumentsDirectory();
    }

    var candidate = File('${dir.path}/${offer.name}');
    if (!await candidate.exists()) return candidate.path;

    final dot = offer.name.lastIndexOf('.');
    final stem = dot > 0 ? offer.name.substring(0, dot) : offer.name;
    final ext = dot > 0 ? offer.name.substring(dot) : '';

    for (var i = 2; i < 1000; i++) {
      candidate = File('${dir.path}/$stem ($i)$ext');
      if (!await candidate.exists()) return candidate.path;
    }
    return '${dir.path}/$stem-${DateTime.now().millisecondsSinceEpoch}$ext';
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
            title: 'Receiving ${s.offer?.name ?? 'file'}',
            body: _serviceLine(s.progress),
          ),
        );
      case TransferState.complete:
      case TransferState.failed:
      case TransferState.declined:
      case TransferState.peerGone:
      case TransferState.expired:
        unawaited(TransferService.stop());
      default:
        break;
    }
  }

  String _serviceLine(Progress p) =>
      '${(p.fraction * 100).toStringAsFixed(0)}% · ${formatBytes(p.transferred)} '
      'of ${formatBytes(p.total)} · ${formatRate(p.bytesPerSecond)}';

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
      ..showSnackBar(
        SnackBar(content: Text(message), backgroundColor: Palette.panel),
      );
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
      _linkController.clear();
    });
  }

  /* ---------------------------------------------------------------- view */

  @override
  Widget build(BuildContext context) {
    return WithForegroundTask(
      child: Scaffold(
        appBar: AppBar(
          title: Row(
            children: [
              const _Mark(),
              const SizedBox(width: 10),
              const Text(
                'Direct',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
              ),
              const Spacer(),
              if (_send != null || _receive != null)
                TextButton(
                  onPressed: _reset,
                  child: const Text(
                    'Reset',
                    style: TextStyle(color: Palette.inkSoft),
                  ),
                ),
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
      return _SenderView(snap: _send!, onCancel: _reset, onCopy: _copyLink);
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 12),
        const Text(
          'Send a file straight\nto another device.',
          style: TextStyle(
            fontSize: 30,
            height: 1.1,
            fontWeight: FontWeight.w600,
            letterSpacing: -0.8,
          ),
        ),
        const SizedBox(height: 14),
        const Text(
          'Nothing uploads. The file goes directly between the two devices, '
          'and it keeps going while this app is in the background.',
          style: TextStyle(fontSize: 15, height: 1.55, color: Palette.inkSoft),
        ),
        const SizedBox(height: 28),

        Panel(
          child: Column(
            children: [
              const Endpoints(from: 'This phone', to: 'Them'),
              const SizedBox(height: 22),
              if (_picking)
                const Working(
                  label: 'Opening the file…',
                  patience:
                      'Android copies large files out of shared storage before '
                      'handing them over, which can take a while for a video.',
                )
              else
                FilledButton(
                  onPressed: _pickAndSend,
                  child: const Text('Choose a file'),
                ),
              const SizedBox(height: 10),
              Text(
                'up to ${formatBytes(maxTransferBytes)}',
                style: const TextStyle(fontSize: 12.5, color: Palette.inkFaint),
              ),
            ],
          ),
        ),

        const SizedBox(height: 22),
        const Row(
          children: [
            Expanded(child: Divider(color: Palette.line)),
            Padding(
              padding: EdgeInsets.symmetric(horizontal: 12),
              child: Text(
                'OR RECEIVE',
                style: TextStyle(
                  fontSize: 10.5,
                  color: Palette.inkFaint,
                  letterSpacing: 1.4,
                ),
              ),
            ),
            Expanded(child: Divider(color: Palette.line)),
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
                style: tabular.copyWith(fontSize: 12.5),
                maxLines: 2,
                minLines: 1,
                decoration: InputDecoration(
                  hintText: 'https://…/t/…#token=…',
                  hintStyle: const TextStyle(
                    color: Palette.inkFaint,
                    fontSize: 12.5,
                  ),
                  filled: true,
                  fillColor: Palette.panelSoft,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: const BorderSide(color: Palette.line),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: const BorderSide(color: Palette.line),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              OutlinedButton(
                onPressed: _openLink,
                child: const Text('Open link'),
              ),
              const SizedBox(height: 10),
              const Text(
                'The whole link matters, including the part after the #. That is the key '
                'to the transfer, and some chat apps trim it.',
                style: TextStyle(
                  fontSize: 12,
                  height: 1.5,
                  color: Palette.inkFaint,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/* ------------------------------------------------------------------ views */

class _SenderView extends StatelessWidget {
  final SenderSnapshot snap;
  final VoidCallback onCancel;
  final void Function(String url) onCopy;

  const _SenderView({
    required this.snap,
    required this.onCancel,
    required this.onCopy,
  });

  @override
  Widget build(BuildContext context) {
    final moving =
        snap.state == TransferState.transferring ||
        snap.state == TransferState.verifying;

    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          FileLine(name: snap.fileName, size: snap.fileSize),
          const SizedBox(height: 20),
          Endpoints(
            from: 'This phone',
            to: 'Them',
            live: moving,
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

          if (snap.shareUrl != null &&
              (snap.state == TransferState.waiting ||
                  snap.state == TransferState.connecting ||
                  snap.state == TransferState.offering)) ...[
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Palette.panelSoft,
                border: Border.all(color: Palette.line),
                borderRadius: BorderRadius.circular(12),
              ),
              child: SelectableText(
                snap.shareUrl!,
                style: tabular.copyWith(
                  fontSize: 11.5,
                  color: Palette.inkSoft,
                  height: 1.5,
                ),
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              // Clipboard rather than a share sheet: one fewer plugin, and
              // the link still goes wherever the user wants it.
              onPressed: () => onCopy(snap.shareUrl!),
              child: const Text('Copy the link'),
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
                      'close this one: the file is sent from this phone.',
                _ => 'Connected. Waiting for them to accept the file.',
              }),
          ],

          if (moving) ...[
            ProgressReadout(
              progress: snap.progress,
              label: snap.state == TransferState.verifying
                  ? 'Sent — waiting for them to finish saving…'
                  : 'Sending',
            ),
            const SizedBox(height: 14),
            const Notice(
              'You can leave the app. The transfer keeps running and shows '
              'progress in your notifications.',
            ),
          ],

          if (snap.state == TransferState.complete)
            const Notice(
              'Sent and verified. The file reached their device intact.',
              tone: NoticeTone.good,
            ),

          if (snap.state == TransferState.declined)
            const Notice('They declined the file.'),
          if (snap.state == TransferState.failed)
            Notice(
              snap.error ?? 'The transfer failed.',
              tone: NoticeTone.error,
            ),

          const SizedBox(height: 18),
          OutlinedButton(
            onPressed: onCancel,
            child: Text(moving ? 'Cancel transfer' : 'Start over'),
          ),
        ],
      ),
    );
  }
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
    final offer = snap.offer;
    final moving =
        snap.state == TransferState.transferring ||
        snap.state == TransferState.verifying;

    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (offer != null)
            FileLine(name: offer.name, size: offer.size)
          else
            const Text(
              'Incoming transfer',
              style: TextStyle(fontSize: 15, color: Palette.inkSoft),
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

          if (snap.state == TransferState.offered && offer != null) ...[
            const Notice(
              'The file transfers directly from their device. It will be saved '
              'to your Downloads folder.',
            ),
            const SizedBox(height: 14),
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
                  : 'Receiving',
            ),
            const SizedBox(height: 14),
            const Notice(
              'You can leave the app. The transfer keeps running and shows '
              'progress in your notifications.',
            ),
          ],

          if (snap.state == TransferState.complete) ...[
            const Notice(
              'Transfer complete and verified against the sender’s checksum.',
              tone: NoticeTone.good,
            ),
            if (snap.savedPath != null) ...[
              const SizedBox(height: 10),
              Text(
                'Saved to ${snap.savedPath}',
                style: tabular.copyWith(
                  fontSize: 11.5,
                  color: Palette.inkFaint,
                ),
              ),
            ],
          ],

          if (snap.state == TransferState.declined)
            const Notice('You declined the file.'),
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
}

class _Mark extends StatelessWidget {
  const _Mark();

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 22,
    height: 22,
    child: CustomPaint(painter: _MarkPainter()),
  );
}

class _MarkPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final y = size.height / 2;
    canvas.drawCircle(Offset(4, y), 3, Paint()..color = Palette.ink);
    canvas.drawLine(
      Offset(9, y),
      Offset(14, y),
      Paint()
        ..color = Palette.signal
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round,
    );
    canvas.drawCircle(
      Offset(18, y),
      3,
      Paint()
        ..color = Palette.ink
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
  }

  @override
  bool shouldRepaint(_MarkPainter old) => false;
}
