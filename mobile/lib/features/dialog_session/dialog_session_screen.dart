import 'dart:async';

import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../core/api/dialog_processing_client.dart';
import '../../core/data/dialog_session_repository.dart';
import '../../core/realtime/realtime_dialog_controller.dart';

/// Button-triggered live voice session (see CONTEXT.md: "Dialog-Session").
/// No wake word — everything said while a session is active is directed
/// at the AI. Start/stop only, mirroring the OpenAI app's voice mode.
///
/// Deliberately dark/immersive regardless of the app's ambient (light,
/// indigo-seeded) theme — this screen is the "in a call" moment, styled
/// like a voice assistant rather than a form.
class DialogSessionScreen extends StatefulWidget {
  const DialogSessionScreen({super.key});

  @override
  State<DialogSessionScreen> createState() => _DialogSessionScreenState();
}

class _DialogSessionScreenState extends State<DialogSessionScreen>
    with SingleTickerProviderStateMixin {
  final _controller = RealtimeDialogController();
  final _sessionRepository = DialogSessionRepository();
  final _dialogProcessingClient = DialogProcessingClient();
  StreamSubscription<String>? _dialogStateSubscription;
  StreamSubscription<double>? _audioLevelSubscription;
  StreamSubscription<String>? _liveTranscriptSubscription;
  late final AnimationController _breatheController;
  String? _dialogSessionId;
  String? _dialogState;
  String _liveTranscript = '';
  double _audioLevel = 0;
  bool _sessionActive = false;
  bool _sessionChanging = false;

  @override
  void initState() {
    super.initState();
    // Idle "breathing" so the orb feels alive even in total silence, not
    // just a static circle — separate from the real audio-level pulse
    // below, which multiplies on top of this.
    _breatheController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2200),
    )..repeat(reverse: true);

    _dialogStateSubscription = _controller.dialogStates.listen((dialogState) {
      if (mounted) setState(() => _dialogState = dialogState);
    });
    // Real mic amplitude (see RealtimeDialogController.audioLevels), not a
    // decorative animation — this is what tells the user their voice is
    // actually being picked up live, not just that a session is "open".
    _audioLevelSubscription = _controller.audioLevels.listen((level) {
      if (mounted) setState(() => _audioLevel = level);
    });
    _liveTranscriptSubscription = _controller.liveTranscript.listen((text) {
      if (mounted) setState(() => _liveTranscript = text);
    });
  }

  Future<void> _toggleSession() async {
    if (_sessionChanging) return;
    setState(() => _sessionChanging = true);
    try {
      if (_sessionActive) {
        final transcript = _controller.transcript;
        await _controller.endSession();
        final sessionId = _dialogSessionId;
        _dialogSessionId = null;
        if (sessionId != null) {
          await _sessionRepository.endSession(
            sessionId,
            fullTranscript: transcript,
          );
          unawaited(_triggerProcessing(sessionId));
        }
      } else {
        _dialogState = null;
        _liveTranscript = '';
        _audioLevel = 0;
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

  /// Fire-and-forget: the Segmentation/Extraction/Classification pipeline
  /// (docs/implementation-plan.md Phase 2, steps 4-6) is nachgelagert by
  /// design, so it must never block the "Session beendet" UX — but a
  /// failure still needs to reach the user, not vanish silently.
  Future<void> _triggerProcessing(String dialogSessionId) async {
    try {
      await _dialogProcessingClient.triggerProcessing(dialogSessionId);
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

  @override
  void dispose() {
    unawaited(_dialogStateSubscription?.cancel());
    unawaited(_audioLevelSubscription?.cancel());
    unawaited(_liveTranscriptSubscription?.cancel());
    _breatheController.dispose();
    unawaited(_controller.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      extendBodyBehindAppBar: true,
      backgroundColor: const Color(0xFF0B0A1A),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: const Text(
          'KI Voice Context Engine',
          style: TextStyle(color: Colors.white, fontSize: 16),
        ),
        iconTheme: const IconThemeData(color: Colors.white),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Abmelden',
            onPressed: () => Supabase.instance.client.auth.signOut(),
          ),
        ],
      ),
      body: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: RadialGradient(
            center: Alignment(0, -0.3),
            radius: 1.3,
            colors: [Color(0xFF2E2154), Color(0xFF17122E), Color(0xFF0B0A1A)],
            stops: [0.0, 0.55, 1.0],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                AnimatedBuilder(
                  animation: _breatheController,
                  builder: (context, _) {
                    final breathe =
                        0.97 + (_breatheController.value * 0.06);
                    return _VoiceOrb(
                      active: _sessionActive,
                      connecting: _sessionChanging,
                      level: _audioLevel,
                      breathe: breathe,
                      onTap: _toggleSession,
                    );
                  },
                ),
                const SizedBox(height: 28),
                Text(
                  _sessionChanging
                      ? (_sessionActive
                          ? 'Session wird beendet …'
                          : 'Verbindung wird aufgebaut …')
                      : _sessionActive
                          ? 'Tippen zum Beenden'
                          : 'Tippen zum Sprechen',
                  style: const TextStyle(
                    color: Colors.white70,
                    fontSize: 15,
                  ),
                ),
                const SizedBox(height: 18),
                AnimatedOpacity(
                  duration: const Duration(milliseconds: 200),
                  opacity: (_sessionActive && _dialogState != null) ? 1 : 0,
                  child: _dialogState == null
                      ? const SizedBox(height: 30)
                      : _DialogStateChip(state: _dialogState!),
                ),
                const SizedBox(height: 20),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 32),
                  child: AnimatedSize(
                    duration: const Duration(milliseconds: 180),
                    curve: Curves.easeOut,
                    alignment: Alignment.topCenter,
                    child: (_sessionActive && _liveTranscript.isNotEmpty)
                        ? _LiveTranscriptCard(text: _liveTranscript)
                        : const SizedBox.shrink(),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The central tap target and live visualizer in one: a glowing orb that
/// grows with real mic amplitude on top of a slow idle "breathing" motion,
/// so the screen feels alive whether or not the user is currently talking.
class _VoiceOrb extends StatelessWidget {
  const _VoiceOrb({
    required this.active,
    required this.connecting,
    required this.level,
    required this.breathe,
    required this.onTap,
  });

  final bool active;
  final bool connecting;
  final double level;
  final double breathe;
  final VoidCallback onTap;

  static const _baseSize = 148.0;
  static const _maxGrowth = 54.0;
  static const _accentA = Color(0xFFA78BFA);
  static const _accentB = Color(0xFF6366F1);

  @override
  Widget build(BuildContext context) {
    final glow = active ? level.clamp(0.0, 1.0) : 0.0;
    final size = (_baseSize + glow * _maxGrowth) * breathe;

    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Stack(
        alignment: Alignment.center,
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            curve: Curves.easeOut,
            width: size + 56,
            height: size + 56,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(
                colors: [
                  _accentA.withValues(alpha: active ? 0.30 : 0.12),
                  _accentA.withValues(alpha: 0),
                ],
              ),
            ),
          ),
          AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            curve: Curves.easeOut,
            width: size,
            height: size,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: const LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [_accentA, _accentB],
              ),
              boxShadow: [
                BoxShadow(
                  color: _accentB.withValues(alpha: 0.45),
                  blurRadius: 22 + glow * 26,
                  spreadRadius: 1 + glow * 5,
                ),
              ],
            ),
            child: Icon(
              active ? Icons.stop_rounded : Icons.mic_rounded,
              color: Colors.white,
              size: 46,
            ),
          ),
          if (connecting)
            const SizedBox(
              width: _baseSize + 20,
              height: _baseSize + 20,
              child: Padding(
                padding: EdgeInsets.all(4),
                child: CircularProgressIndicator(
                  strokeWidth: 2.5,
                  valueColor: AlwaysStoppedAnimation(Colors.white70),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Small pill showing the live Dialogzustand (see CONTEXT.md
/// "Dialogzustand") reported via set_dialog_state — color-coded so the
/// state is readable at a glance without parsing text.
class _DialogStateChip extends StatelessWidget {
  const _DialogStateChip({required this.state});

  final String state;

  @override
  Widget build(BuildContext context) {
    final (label, icon, color) = switch (state) {
      'zuhoeren' => ('Hört zu', Icons.hearing_rounded, const Color(0xFF9CA3AF)),
      'antworten' => (
          'Antwortet',
          Icons.chat_bubble_rounded,
          const Color(0xFF60A5FA)
        ),
      'nachfragen' => (
          'Fragt nach',
          Icons.help_rounded,
          const Color(0xFFFBBF24)
        ),
      _ => (state, Icons.circle, Colors.white70),
    };

    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 200),
      child: Container(
        key: ValueKey(state),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: color.withValues(alpha: 0.4)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 15, color: color),
            const SizedBox(width: 6),
            Text(
              label,
              style: TextStyle(
                color: color,
                fontWeight: FontWeight.w600,
                fontSize: 13,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Live-building caption of what the user is currently saying (see
/// RealtimeDialogController.liveTranscript) — styled as a soft glass card
/// so it reads as a caption overlay, not a form field.
class _LiveTranscriptCard extends StatelessWidget {
  const _LiveTranscriptCard({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 340),
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.white.withValues(alpha: 0.12)),
      ),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 16,
          height: 1.4,
        ),
      ),
    );
  }
}
