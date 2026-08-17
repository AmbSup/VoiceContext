import 'package:flutter/material.dart';

import '../../core/api/context_sources_client.dart';
import '../../core/theme/modernist_colors.dart';
import '../dialog_session/context_source_panel.dart';

/// Kontext tab: persistent context-source picker. Pre-session, this is
/// where the sources used by the next "Session starten" tap are chosen;
/// while a session is active, the same list stays editable and a
/// "KONTEXT ÜBERNEHMEN" action pushes the change live via
/// RealtimeDialogController.updateInstructions (session.update over the
/// WebRTC data channel). All fetch/toggle state is owned by MainShell —
/// this widget is purely presentational.
class KontextTab extends StatelessWidget {
  const KontextTab({
    super.key,
    required this.sources,
    required this.enabled,
    required this.tokenBudget,
    required this.sessionActive,
    required this.applyingUpdate,
    required this.loading,
    required this.loadError,
    required this.onRetry,
    required this.onToggle,
    required this.onReset,
    required this.onApply,
    required this.onChangeDefaultContext,
  });

  final List<ContextSource>? sources;
  final Map<String, bool>? enabled;
  final int tokenBudget;
  final bool sessionActive;
  final bool applyingUpdate;
  final bool loading;
  final String? loadError;
  final VoidCallback onRetry;
  final ValueChanged<String> onToggle;
  final VoidCallback onReset;
  final VoidCallback onApply;
  /// null contextId means "kein Standardkontext" (clear).
  final ValueChanged<String?> onChangeDefaultContext;

  @override
  Widget build(BuildContext context) {
    final sources = this.sources;
    final enabled = this.enabled;
    if (sources == null || enabled == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: loadError == null
              ? const CircularProgressIndicator(
                  color: ModernistColors.accent,
                )
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      loadError!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: ModernistColors.textMuted),
                    ),
                    const SizedBox(height: 16),
                    OutlinedButton(
                      onPressed: loading ? null : onRetry,
                      child: Text(loading ? 'LÄDT …' : 'NOCHMALS'),
                    ),
                  ],
                ),
        ),
      );
    }

    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            child: ContextSourcePanel(
              sources: sources,
              enabled: enabled,
              tokenBudget: tokenBudget,
              onToggle: onToggle,
              onChangeDefault: () =>
                  _showDefaultContextPicker(context, sources),
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
            height: 52,
            child: Row(
              children: [
                OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: ModernistColors.text,
                    side: const BorderSide(color: ModernistColors.divider),
                    shape: const RoundedRectangleBorder(),
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                  ),
                  onPressed: onReset,
                  child: const Text(
                    'ZURÜCKSETZEN',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.6,
                    ),
                  ),
                ),
                if (sessionActive) ...[
                  const SizedBox(width: 2),
                  Expanded(
                    child: SizedBox(
                      height: 52,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: ModernistColors.accent,
                          foregroundColor: ModernistColors.bg,
                          elevation: 0,
                          shape: const RoundedRectangleBorder(),
                          padding: const EdgeInsets.symmetric(horizontal: 16),
                        ),
                        onPressed: applyingUpdate ? null : onApply,
                        child: Text(
                          applyingUpdate
                              ? 'WIRD ÜBERNOMMEN …'
                              : 'KONTEXT ÜBERNEHMEN',
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.6,
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  /// Direct-tap alternative to the voice-only propose/confirm flow
  /// (RealtimeDialogController's propose_active_context_switch/
  /// confirm_active_context_switch) — a deliberate tap on a concrete
  /// context needs no two-step disambiguation, unlike a spoken name.
  void _showDefaultContextPicker(
    BuildContext context,
    List<ContextSource> sources,
  ) {
    final activeContextSources =
        sources.where((s) => s.kind == 'active_context');
    final currentDefaultId =
        activeContextSources.isEmpty ? null : activeContextSources.first.id;
    final candidates = sources.where((s) => s.kind == 'context').toList();

    showModalBottomSheet<void>(
      context: context,
      backgroundColor: ModernistColors.bg,
      shape: const RoundedRectangleBorder(),
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 20, 20, 8),
              child: Text(
                'STANDARDKONTEXT',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.0,
                  color: ModernistColors.text,
                ),
              ),
            ),
            ListTile(
              title: const Text(
                'Kein Standardkontext',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
              trailing: currentDefaultId == null
                  ? const Icon(Icons.check, color: ModernistColors.accent)
                  : null,
              onTap: () {
                Navigator.of(sheetContext).pop();
                onChangeDefaultContext(null);
              },
            ),
            const Divider(height: 1, color: ModernistColors.dividerLight),
            if (candidates.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 20, vertical: 16),
                child: Text(
                  'Keine weiteren Kontexte vorhanden.',
                  style: TextStyle(color: ModernistColors.textMuted),
                ),
              )
            else
              for (final candidate in candidates)
                ListTile(
                  title: Text(candidate.label),
                  subtitle: candidate.meta.isNotEmpty
                      ? Text(
                          candidate.meta,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        )
                      : null,
                  trailing: candidate.id == currentDefaultId
                      ? const Icon(Icons.check, color: ModernistColors.accent)
                      : null,
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    onChangeDefaultContext(candidate.id);
                  },
                ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}
