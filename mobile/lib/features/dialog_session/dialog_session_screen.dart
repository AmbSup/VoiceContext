import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../core/api/dialog_processing_client.dart';
import '../../core/data/context_summary_repository.dart';
import '../../core/data/dialog_session_repository.dart';
import '../../core/realtime/realtime_dialog_controller.dart';

/// Button-triggered live voice session (see CONTEXT.md: "Dialog-Session").
/// No wake word — everything said while a session is active is directed
/// at the AI. Start/stop only, mirroring the OpenAI app's voice mode.
class DialogSessionScreen extends StatefulWidget {
  const DialogSessionScreen({super.key});

  @override
  State<DialogSessionScreen> createState() => _DialogSessionScreenState();
}

// Number of bars shown in the waveform — also the length of the rolling
// sample buffer it scrolls through (see _audioLevels below).
const _waveformBarCount = 28;

// Bumped by hand on every redeploy to the phone so a fresh install is
// visually confirmable on-screen — see the "USB Debugging"/eventLog mixup
// where a hot-reloaded build silently ran stale code. Purely a debugging
// aid, not a real app version.
const _buildVersion = 'v2';

class _DialogSessionScreenState extends State<DialogSessionScreen> {
  final _controller = RealtimeDialogController();
  final _sessionRepository = DialogSessionRepository();
  final _contextSummaryRepository = ContextSummaryRepository();
  final _dialogProcessingClient = DialogProcessingClient();
  StreamSubscription<String>? _dialogStateSubscription;
  StreamSubscription<double>? _audioLevelSubscription;
  StreamSubscription<String>? _liveTranscriptSubscription;
  StreamSubscription<bool>? _thinkingSubscription;
  String? _dialogSessionId;
  String? _dialogState;
  String _liveTranscript = '';
  final List<double> _audioLevels =
      List<double>.filled(_waveformBarCount, 0, growable: true);
  bool _sessionActive = false;
  bool _sessionChanging = false;
  bool _isThinking = false;
  late Future<List<ContextSummary>> _contextSummaries;

  @override
  void initState() {
    super.initState();
    _contextSummaries = _contextSummaryRepository.fetchSummaries();
    _dialogStateSubscription = _controller.dialogStates.listen((dialogState) {
      if (mounted) setState(() => _dialogState = dialogState);
    });
    // Real mic amplitude (see RealtimeDialogController.audioLevels), not a
    // decorative animation — this is what tells the user their voice is
    // actually being picked up live, not just that a session is "open".
    _audioLevelSubscription = _controller.audioLevels.listen((level) {
      if (!mounted) return;
      setState(() {
        _audioLevels.removeAt(0);
        _audioLevels.add(level);
      });
    });
    _liveTranscriptSubscription = _controller.liveTranscript.listen((text) {
      if (mounted) setState(() => _liveTranscript = text);
    });
    _thinkingSubscription = _controller.thinking.listen((isThinking) {
      if (mounted) setState(() => _isThinking = isThinking);
    });
  }

  Future<void> _toggleSession() async {
    setState(() => _sessionChanging = true);
    try {
      if (_sessionActive) {
        final transcript = _controller.transcript;
        final eventLog = _controller.eventLog;
        await _controller.endSession();
        final sessionId = _dialogSessionId;
        _dialogSessionId = null;
        if (sessionId != null) {
          await _sessionRepository.endSession(
            sessionId,
            fullTranscript: transcript,
          );
          unawaited(_triggerProcessing(sessionId));
          unawaited(_logEvents(sessionId, eventLog));
        }
      } else {
        _dialogState = null;
        _isThinking = false;
        _liveTranscript = '';
        _audioLevels.setAll(0, List<double>.filled(_waveformBarCount, 0));
        await _controller.startSession();
        try {
          _dialogSessionId = await _sessionRepository.startSession();
        } catch (_) {
          // Don't leave a WebRTC session running that we can't record —
          // Segmentation Engine (Phase 2) needs the persisted row later.
          await _controller.endSession();
          rethrow;
        }
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Dialog-Session fehlgeschlagen: $error')),
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _sessionActive = _controller.isConnected;
          _sessionChanging = false;
        });
      }
    }
  }

  /// Fire-and-forget, silent on failure: this is a debugging aid (see
  /// dialog_session_events), not a core feature — a lost event log should
  /// never interrupt or alarm the user the way a lost transcript would.
  Future<void> _logEvents(
    String dialogSessionId,
    List<Map<String, dynamic>> eventLog,
  ) async {
    try {
      await _sessionRepository.logEvents(dialogSessionId, eventLog);
    } catch (error) {
      debugPrint(
        'Event-Protokoll fehlgeschlagen für Session $dialogSessionId: $error',
      );
    }
  }

  /// Fire-and-forget: the Segmentation/Extraction/Classification pipeline
  /// (docs/implementation-plan.md Phase 2, steps 4-6) is nachgelagert by
  /// design, so it must never block the "Session beendet" UX — but a
  /// failure still needs to reach the user, not vanish silently.
  Future<void> _triggerProcessing(String dialogSessionId) async {
    try {
      await _dialogProcessingClient.triggerProcessing(dialogSessionId);
      if (mounted) {
        setState(() {
          _contextSummaries = _contextSummaryRepository.fetchSummaries();
        });
      }
    } catch (error) {
      debugPrint(
        'Nachbearbeitung fehlgeschlagen für Session $dialogSessionId: $error',
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Verarbeitung der Session ist fehlgeschlagen. Die Inhalte '
              'gehen nicht verloren, bitte später erneut versuchen.',
            ),
          ),
        );
      }
    }
  }

  String _dialogStateLabel(String dialogState) => switch (dialogState) {
        'zuhoeren' => 'Hört zu',
        'antworten' => 'Antwortet',
        'nachfragen' => 'Fragt nach',
        _ => dialogState,
      };

  @override
  void dispose() {
    unawaited(_dialogStateSubscription?.cancel());
    unawaited(_audioLevelSubscription?.cancel());
    unawaited(_liveTranscriptSubscription?.cancel());
    unawaited(_thinkingSubscription?.cancel());
    unawaited(_controller.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('KI Voice Context Engine'),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(
                color: Theme.of(context)
                    .colorScheme
                    .primary
                    .withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                _buildVersion,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: Theme.of(context).colorScheme.primary,
                ),
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Abmelden',
            onPressed: () => Supabase.instance.client.auth.signOut(),
          ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 32, 20, 40),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_sessionActive) ...[
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 350),
                  child: _isThinking
                      ? const _ThinkingOrb(key: ValueKey('thinking'))
                      : _AudioWaveform(
                          key: const ValueKey('listening'),
                          levels: _audioLevels,
                        ),
                ),
                const SizedBox(height: 16),
              ],
              if (_sessionActive && _liveTranscript.isNotEmpty) ...[
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 320),
                  child: Text(
                    _liveTranscript,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                ),
                const SizedBox(height: 16),
              ],
              ElevatedButton.icon(
                onPressed: _sessionChanging ? null : _toggleSession,
                icon: _sessionChanging
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Icon(_sessionActive ? Icons.stop : Icons.mic),
                label: Text(
                  _sessionChanging
                      ? 'Verbindung wird aufgebaut …'
                      : _sessionActive
                          ? 'Session beenden'
                          : 'Session starten',
                ),
              ),
              if (_sessionActive && _dialogState != null) ...[
                const SizedBox(height: 16),
                Text(
                  _dialogStateLabel(_dialogState!),
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ],
              if (!_sessionActive) ...[
                const SizedBox(height: 36),
                _ContextSummaryList(summaries: _contextSummaries),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _ContextSummaryList extends StatelessWidget {
  const _ContextSummaryList({required this.summaries});

  final Future<List<ContextSummary>> summaries;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 520),
      child: FutureBuilder<List<ContextSummary>>(
        future: summaries,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Padding(
              padding: EdgeInsets.all(24),
              child: CircularProgressIndicator(strokeWidth: 2),
            );
          }
          if (snapshot.hasError) {
            return Text(
              'Kontexte konnten nicht geladen werden.',
              style: Theme.of(context).textTheme.bodySmall,
            );
          }

          final items = snapshot.data ?? const [];
          if (items.isEmpty) return const SizedBox.shrink();

          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'DEINE KONTEXTE',
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      letterSpacing: 1.4,
                      fontWeight: FontWeight.w700,
                    ),
              ),
              const SizedBox(height: 10),
              Card(
                clipBehavior: Clip.antiAlias,
                child: Column(
                  children: [
                    for (var index = 0; index < items.length; index++) ...[
                      ListTile(
                        leading: const Icon(Icons.folder_outlined),
                        title: Text(items[index].name),
                        trailing: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 5,
                          ),
                          decoration: BoxDecoration(
                            color:
                                Theme.of(context).colorScheme.primaryContainer,
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: Text(
                            '${items[index].itemCount} '
                            '${items[index].itemCount == 1 ? 'Item' : 'Items'}',
                            style: Theme.of(context).textTheme.labelMedium,
                          ),
                        ),
                      ),
                      if (index < items.length - 1)
                        const Divider(height: 1, indent: 56),
                    ],
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _ThinkingOrb extends StatefulWidget {
  const _ThinkingOrb({super.key});

  @override
  State<_ThinkingOrb> createState() => _ThinkingOrbState();
}

class _ThinkingOrbState extends State<_ThinkingOrb>
    with SingleTickerProviderStateMixin {
  late final AnimationController _animation;

  @override
  void initState() {
    super.initState();
    _animation = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2400),
    )..repeat();
  }

  @override
  void dispose() {
    _animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? const [Color(0xFF7C4DFF), Color(0xFF00E5FF), Color(0xFFFF4081)]
        : const [Color(0xFF5B3FD6), Color(0xFF00A8C6), Color(0xFFE73C7E)];

    return Semantics(
      label: 'KI denkt',
      child: SizedBox.square(
        dimension: 76,
        child: AnimatedBuilder(
          animation: _animation,
          builder: (context, child) => CustomPaint(
            painter: _ThinkingOrbPainter(
              progress: _animation.value,
              colors: colors,
            ),
          ),
        ),
      ),
    );
  }
}

class _ThinkingOrbPainter extends CustomPainter {
  const _ThinkingOrbPainter({required this.progress, required this.colors});

  final double progress;
  final List<Color> colors;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final phase = progress * math.pi * 2;
    final baseRadius = size.shortestSide * (0.38 + 0.025 * math.sin(phase * 2));
    final path = Path();

    for (var index = 0; index <= 72; index++) {
      final angle = index / 72 * math.pi * 2;
      final radius = baseRadius *
          (1 +
              0.07 * math.sin(angle * 3 + phase) +
              0.035 * math.sin(angle * 5 - phase * 1.4));
      final point = center + Offset(math.cos(angle), math.sin(angle)) * radius;
      if (index == 0) {
        path.moveTo(point.dx, point.dy);
      } else {
        path.lineTo(point.dx, point.dy);
      }
    }
    path.close();

    final paint = Paint()
      ..shader = SweepGradient(
        colors: [...colors, colors.first],
        transform: GradientRotation(phase),
      ).createShader(Offset.zero & size)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2.5);
    canvas.drawShadow(path, colors.first.withValues(alpha: 0.35), 10, true);
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _ThinkingOrbPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.colors != colors;
}

/// Renders [levels] (oldest to newest, each 0.0-1.0) as a scrolling bar
/// waveform — real mic amplitude from RealtimeDialogController.audioLevels,
/// so a bar visibly rising as soon as the user starts talking is direct,
/// immediate proof that their voice is being captured live.
class _AudioWaveform extends StatelessWidget {
  const _AudioWaveform({super.key, required this.levels});

  final List<double> levels;

  static const _barWidth = 4.0;
  static const _barSpacing = 3.0;
  static const _maxBarHeight = 40.0;
  static const _minBarHeight = 4.0;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.primary;
    return SizedBox(
      height: _maxBarHeight,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          for (final level in levels)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: _barSpacing / 2),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 100),
                width: _barWidth,
                height: _minBarHeight +
                    (level.clamp(0.0, 1.0) * (_maxBarHeight - _minBarHeight)),
                decoration: BoxDecoration(
                  color: color,
                  borderRadius: BorderRadius.circular(_barWidth / 2),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
