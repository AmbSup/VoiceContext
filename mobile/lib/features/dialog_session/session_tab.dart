import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api/active_context_client.dart';
import '../../core/api/context_sources_client.dart';
import '../../core/realtime/realtime_dialog_controller.dart';
import '../../core/theme/modernist_colors.dart';
import 'dialog_visuals.dart';

/// Session tab: the focused live-dialog view — mic Start/Stop, waveform/
/// thinking-orb, live transcript, processing activity, dialog-state label.
/// Session lifecycle (start/stop) and most state is owned by MainShell and
/// passed in as props; audioLevels/thinking are subscribed to locally here
/// since they fire rapidly (~10/s) and would otherwise rebuild the other,
/// off-screen tabs on every tick if they lived on MainShell.
///
/// Styled after the "Modernist" Claude Design mockup this screen was built
/// from: flat, sharp-cornered, thick-rule sections, red-orange accent —
/// deliberately not Material defaults.
class SessionTab extends StatefulWidget {
  const SessionTab({
    super.key,
    required this.controller,
    required this.sessionActive,
    required this.sessionChanging,
    required this.liveTranscript,
    required this.processingActivity,
    required this.activeContext,
    required this.dialogState,
    required this.onToggleSession,
    required this.sources,
    required this.enabledSourceIds,
    required this.onToggleSource,
  });

  final RealtimeDialogController controller;
  final bool sessionActive;
  final bool sessionChanging;
  final String liveTranscript;
  final String processingActivity;
  final ActiveContext? activeContext;
  final String? dialogState;
  final VoidCallback onToggleSession;

  /// Compact active-content-group selector shown on this screen (below the
  /// waveform/transcript) — the same source-toggle state the Kontext tab
  /// edits in full detail, owned by MainShell. Toggling here or in Kontext
  /// tab affects the same underlying selection.
  final List<ContextSource>? sources;
  final Map<String, bool>? enabledSourceIds;
  final ValueChanged<String> onToggleSource;

  @override
  State<SessionTab> createState() => _SessionTabState();
}

const _waveformBarCount = 28;

class _SessionTabState extends State<SessionTab> {
  final List<double> _audioLevels =
      List<double>.filled(_waveformBarCount, 0, growable: true);
  bool _isThinking = false;
  StreamSubscription<double>? _audioLevelSubscription;
  StreamSubscription<bool>? _thinkingSubscription;

  @override
  void initState() {
    super.initState();
    // Real mic amplitude (see RealtimeDialogController.audioLevels), not a
    // decorative animation — this is what tells the user their voice is
    // actually being picked up live, not just that a session is "open".
    _audioLevelSubscription = widget.controller.audioLevels.listen((level) {
      if (!mounted) return;
      setState(() {
        _audioLevels.removeAt(0);
        _audioLevels.add(level);
      });
    });
    _thinkingSubscription = widget.controller.thinking.listen((isThinking) {
      if (mounted) setState(() => _isThinking = isThinking);
    });
  }

  @override
  void dispose() {
    unawaited(_audioLevelSubscription?.cancel());
    unawaited(_thinkingSubscription?.cancel());
    super.dispose();
  }

  String _dialogStateLabel(String dialogState) => switch (dialogState) {
        'zuhoeren' => 'HÖRT ZU',
        'antworten' => 'ANTWORTET',
        'nachfragen' => 'FRAGT NACH',
        _ => dialogState.toUpperCase(),
      };

  @override
  Widget build(BuildContext context) {
    final stateLabel = widget.sessionActive && widget.dialogState != null
        ? _dialogStateLabel(widget.dialogState!)
        : widget.sessionChanging
            ? 'VERBINDET …'
            : widget.sessionActive
                ? 'BEREIT'
                : 'GETRENNT';

    return SafeArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'LIVE-DIALOG',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.4,
                    color: ModernistColors.text,
                  ),
                ),
                Text(
                  stateLabel,
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.8,
                    color: ModernistColors.accentDark,
                  ),
                ),
              ],
            ),
          ),
          const Divider(height: 2, thickness: 2, color: ModernistColors.divider),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 350),
                    child: _isThinking
                        ? const ThinkingOrb(key: ValueKey('thinking'))
                        : AudioWaveform(
                            key: const ValueKey('listening'),
                            levels: widget.sessionActive
                                ? _audioLevels
                                : List<double>.filled(_waveformBarCount, 0),
                          ),
                  ),
                  const SizedBox(height: 20),
                  if (widget.sessionActive && widget.liveTranscript.isNotEmpty) ...[
                    Text(
                      widget.liveTranscript,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 22,
                        height: 1.25,
                        fontWeight: FontWeight.w800,
                        letterSpacing: -0.3,
                        color: ModernistColors.text,
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                  // Separate from liveTranscript on purpose: gpt-realtime is
                  // audio-native and never sees the transcript above as
                  // input, it hears the same audio independently — on
                  // unclear speech the two can genuinely disagree. This
                  // shows what the model itself acted on (its own
                  // function-call arguments), not another transcription
                  // model's guess at the same audio.
                  if (widget.sessionActive && widget.processingActivity.isNotEmpty) ...[
                    Container(
                      padding: const EdgeInsets.only(left: 10),
                      decoration: const BoxDecoration(
                        border: Border(
                          left: BorderSide(color: ModernistColors.accent, width: 2),
                        ),
                      ),
                      child: Text(
                        'Verarbeitet: ${widget.processingActivity}',
                        textAlign: TextAlign.left,
                        style: const TextStyle(
                          fontSize: 12.5,
                          color: ModernistColors.textMuted,
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                  const SizedBox(height: 16),
                  _SourceGroupSelector(
                    sources: widget.sources,
                    enabledSourceIds: widget.enabledSourceIds,
                    onToggle: widget.onToggleSource,
                  ),
                ],
              ),
            ),
          ),
          Container(
            decoration: const BoxDecoration(
              border: Border(
                top: BorderSide(color: ModernistColors.divider, width: 2),
              ),
            ),
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
            child: SizedBox(
              width: double.infinity,
              height: 56,
              child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(
                  backgroundColor: ModernistColors.accent,
                  foregroundColor: ModernistColors.bg,
                  disabledBackgroundColor: ModernistColors.neutralTintBg,
                  disabledForegroundColor: ModernistColors.textFaint,
                  elevation: 0,
                  shape: const RoundedRectangleBorder(),
                  alignment: Alignment.centerLeft,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                ),
                onPressed: widget.sessionChanging ? null : widget.onToggleSession,
                icon: widget.sessionChanging
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Icon(widget.sessionActive ? Icons.stop : Icons.mic),
                label: Text(
                  widget.sessionChanging
                      ? 'VERBINDUNG WIRD AUFGEBAUT …'
                      : widget.sessionActive
                          ? 'SESSION BEENDEN'
                          : 'SESSION STARTEN',
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.8,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Compact, always-visible content-group picker on the Session tab — the
/// same underlying source-toggle state the Kontext tab edits with full
/// detail (token counts, sectioning, live-apply), condensed to tappable
/// chips so it fits inline here. The confirmed active context is shown
/// locked (matches Kontext tab's pinned row) since it's always included.
class _SourceGroupSelector extends StatelessWidget {
  const _SourceGroupSelector({
    required this.sources,
    required this.enabledSourceIds,
    required this.onToggle,
  });

  final List<ContextSource>? sources;
  final Map<String, bool>? enabledSourceIds;
  final ValueChanged<String> onToggle;

  @override
  Widget build(BuildContext context) {
    final sources = this.sources;
    final enabled = enabledSourceIds;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(border: Border.all(color: ModernistColors.divider)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'AKTIVE INHALTS-GRUPPEN',
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.8,
              color: ModernistColors.textMuted,
            ),
          ),
          const SizedBox(height: 10),
          if (sources == null || enabled == null)
            const SizedBox(
              height: 20,
              width: 20,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: ModernistColors.accent,
              ),
            )
          else if (sources.isEmpty)
            const Text(
              'Keine Kontextquellen gefunden.',
              style: TextStyle(fontSize: 12, color: ModernistColors.textFaint),
            )
          else
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final source in sources)
                  _SourceChip(
                    label: source.label,
                    on: source.kind == 'active_context'
                        ? true
                        : (enabled[source.id] ?? false),
                    locked: source.kind == 'active_context',
                    onTap: source.kind == 'active_context'
                        ? null
                        : () => onToggle(source.id),
                  ),
              ],
            ),
        ],
      ),
    );
  }
}

class _SourceChip extends StatelessWidget {
  const _SourceChip({
    required this.label,
    required this.on,
    required this.locked,
    required this.onTap,
  });

  final String label;
  final bool on;
  final bool locked;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: on ? ModernistColors.accentTintBg : ModernistColors.neutralTintBg,
          border: Border.all(
            color: on ? ModernistColors.accent : ModernistColors.divider,
          ),
        ),
        child: Text(
          locked ? '$label · STANDARD' : label,
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.w800,
            letterSpacing: 0.2,
            color: on ? ModernistColors.accentDark : ModernistColors.textFaint,
            decoration: (!on && !locked) ? TextDecoration.lineThrough : null,
          ),
        ),
      ),
    );
  }
}
