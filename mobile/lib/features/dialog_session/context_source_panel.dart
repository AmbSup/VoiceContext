import 'package:flutter/material.dart';

import '../../core/api/context_sources_client.dart';
import '../../core/theme/modernist_colors.dart';

/// Token-budget bar + sectioned, toggleable context-source list — the
/// shared visual core of both the pre-session picker
/// (`ContextSelectionScreen`) and the live, mid-session panel embedded in
/// `DialogSessionScreen`. Purely presentational: state (which sources are
/// enabled, the fetch itself) is owned by whichever screen embeds this.
///
/// Styled after the "Modernist" Claude Design mockup this UI was built
/// from: flat, sharp-cornered, thick-rule sections, red-orange accent —
/// deliberately not Material defaults. Callers are responsible for their
/// own scroll container (this widget shrink-wraps, it never scrolls
/// itself) and for any reset/primary action buttons.
class ContextSourcePanel extends StatelessWidget {
  const ContextSourcePanel({
    super.key,
    required this.sources,
    required this.enabled,
    required this.tokenBudget,
    required this.onToggle,
    this.onChangeDefault,
  });

  final List<ContextSource> sources;
  final Map<String, bool> enabled;
  final int tokenBudget;
  final ValueChanged<String> onToggle;
  /// Opens the default-context picker (change or clear). Null hides the
  /// action — the compact inline panel embedded in SessionTab doesn't offer
  /// this, only the full Kontext tab does.
  final VoidCallback? onChangeDefault;

  static const _kindOrder = ['active_context', 'context', 'document', 'session'];
  static const _kindLabels = {
    'active_context': 'STANDARDKONTEXT',
    'context': 'WEITERE KONTEXTE',
    'document': 'DOKUMENTE',
    'session': 'LETZTE SESSIONS',
  };

  int get _usedTokens => sources
      .where((s) => enabled[s.id] ?? false)
      .fold(0, (sum, s) => sum + s.tokenCount);

  int get _activeCount => enabled.values.where((v) => v).length;

  @override
  Widget build(BuildContext context) {
    final overBudget = tokenBudget > 0 && _usedTokens > tokenBudget;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    '$_usedTokens / $tokenBudget TOKEN',
                    style: TextStyle(
                      fontSize: 11,
                      letterSpacing: 0.8,
                      fontWeight: FontWeight.w800,
                      color: overBudget
                          ? ModernistColors.accentDark
                          : ModernistColors.text,
                    ),
                  ),
                  Text(
                    '$_activeCount ${_activeCount == 1 ? "QUELLE" : "QUELLEN"} AKTIV',
                    style: const TextStyle(
                      fontSize: 11,
                      letterSpacing: 0.8,
                      color: ModernistColors.textMuted,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Container(
                height: 8,
                color: ModernistColors.trackBg,
                alignment: Alignment.centerLeft,
                child: FractionallySizedBox(
                  widthFactor: tokenBudget > 0
                      ? (_usedTokens / tokenBudget).clamp(0.0, 1.0)
                      : 0,
                  child: Container(
                    height: 8,
                    color: overBudget
                        ? ModernistColors.accentDark
                        : ModernistColors.accent,
                  ),
                ),
              ),
            ],
          ),
        ),
        for (final kind in _kindOrder)
          ..._buildSection(kind, sources.where((s) => s.kind == kind).toList()),
      ],
    );
  }

  List<Widget> _buildSection(String kind, List<ContextSource> kindSources) {
    final isActiveContextSection = kind == 'active_context';
    // Every other section simply disappears when empty; the active-context
    // section stays visible even with zero sources so "kein Standardkontext
    // gesetzt" is a state the user can see and act on, not just silence.
    if (kindSources.isEmpty && !isActiveContextSection) return const [];
    // The active-context source is pinned: always on, no toggle shown —
    // mirrors realtime-token/route.ts always including it server-side.
    // Which context IS the default is changed via onChangeDefault instead,
    // not by toggling it off here.
    final locked = isActiveContextSection;
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 8),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              _kindLabels[kind] ?? kind.toUpperCase(),
              style: const TextStyle(
                fontSize: 11,
                letterSpacing: 1.2,
                fontWeight: FontWeight.w800,
                color: ModernistColors.text,
              ),
            ),
            if (isActiveContextSection && onChangeDefault != null)
              InkWell(
                onTap: onChangeDefault,
                child: Text(
                  kindSources.isEmpty ? 'FESTLEGEN' : 'ÄNDERN',
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.6,
                    color: ModernistColors.accentDark,
                  ),
                ),
              )
            else if (!locked)
              const Text(
                'TIPPEN ZUM SCHALTEN',
                style: TextStyle(fontSize: 10, color: ModernistColors.textMuted),
              ),
          ],
        ),
      ),
      Container(
        decoration: const BoxDecoration(
          border: Border(
            top: BorderSide(color: ModernistColors.divider, width: 2),
            bottom: BorderSide(color: ModernistColors.divider, width: 2),
          ),
        ),
        child: kindSources.isEmpty
            ? const Padding(
                padding: EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                child: Text(
                  'Kein Standardkontext gesetzt.',
                  style: TextStyle(fontSize: 13, color: ModernistColors.textMuted),
                ),
              )
            : Column(
                children: [
                  for (var i = 0; i < kindSources.length; i++) ...[
                    _SourceRow(
                      source: kindSources[i],
                      on: locked ? true : (enabled[kindSources[i].id] ?? false),
                      locked: locked,
                      onToggle: locked ? null : () => onToggle(kindSources[i].id),
                    ),
                    if (i < kindSources.length - 1)
                      const Divider(height: 1, thickness: 1, color: ModernistColors.dividerLight),
                  ],
                ],
              ),
      ),
    ];
  }
}

class _SourceRow extends StatelessWidget {
  const _SourceRow({
    required this.source,
    required this.on,
    required this.locked,
    required this.onToggle,
  });

  final ContextSource source;
  final bool on;
  final bool locked;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final tagLabel = locked ? 'STANDARD' : (on ? 'AN' : 'AUS');
    return InkWell(
      onTap: onToggle,
      child: Container(
        color: on ? null : ModernistColors.neutralTintBg,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 14,
              height: 14,
              margin: const EdgeInsets.only(top: 4),
              decoration: BoxDecoration(
                color: on ? ModernistColors.accent : Colors.transparent,
                border: on
                    ? null
                    : Border.all(color: ModernistColors.textFaint, width: 2),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    source.label,
                    style: TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w800,
                      letterSpacing: -0.1,
                      color: on ? ModernistColors.text : ModernistColors.textFaint,
                      decoration: on ? null : TextDecoration.lineThrough,
                    ),
                  ),
                  if (source.meta.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      source.meta,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 11.5,
                        color: ModernistColors.textMuted,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  color: on
                      ? ModernistColors.accentTintBg
                      : ModernistColors.neutralTintBg,
                  child: Text(
                    tagLabel,
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.8,
                      color: on ? ModernistColors.accentDark : ModernistColors.textMuted,
                    ),
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '${source.tokenCount}',
                  style: const TextStyle(
                    fontSize: 10.5,
                    color: ModernistColors.textMuted,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
