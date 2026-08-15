import 'package:flutter/material.dart';

import '../../core/api/context_sources_client.dart';

/// Turn-Kontext-Auswahl: shown before a Dialog-Session starts. Lets the user
/// toggle which context sources (active context, other contexts, linked
/// documents, recent sessions) get included in the Realtime session's
/// instructions, with a live token-budget bar. Pops with the list of
/// enabled source ids, or `null` if the user backed out.
class ContextSelectionScreen extends StatefulWidget {
  const ContextSelectionScreen({super.key});

  @override
  State<ContextSelectionScreen> createState() =>
      _ContextSelectionScreenState();
}

class _ContextSelectionScreenState extends State<ContextSelectionScreen> {
  final _client = ContextSourcesClient();
  late final Future<ContextSourcesResult> _sourcesFuture;
  // Populated once, when the fetch resolves — see initState. Toggling a
  // source afterwards only touches this map, never re-seeds it.
  Map<String, bool>? _enabled;

  @override
  void initState() {
    super.initState();
    _sourcesFuture = _client.fetchSources();
    _sourcesFuture.then((result) {
      if (!mounted) return;
      setState(() {
        _enabled = {
          for (final source in result.sources) source.id: source.defaultEnabled,
        };
      });
    });
  }

  static const _kindOrder = ['active_context', 'context', 'document', 'session'];
  static const _kindLabels = {
    'active_context': 'Standardkontext',
    'context': 'Weitere Kontexte',
    'document': 'Dokumente',
    'session': 'Letzte Sessions',
  };

  int _enabledTokenCount(List<ContextSource> sources) {
    final enabled = _enabled;
    if (enabled == null) return 0;
    return sources
        .where((s) => enabled[s.id] ?? false)
        .fold(0, (sum, s) => sum + s.tokenCount);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Kontext für diese Session')),
      body: SafeArea(
        child: FutureBuilder<ContextSourcesResult>(
          future: _sourcesFuture,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snapshot.hasError || _enabled == null) {
              return Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    'Kontextquellen konnten nicht geladen werden: '
                    '${snapshot.error}',
                    textAlign: TextAlign.center,
                  ),
                ),
              );
            }

            final result = snapshot.data!;
            final enabled = _enabled!;
            final usedTokens = _enabledTokenCount(result.sources);
            final overBudget = result.tokenBudget > 0 &&
                usedTokens > result.tokenBudget;

            return Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text('Token-Budget'),
                          Text(
                            '$usedTokens / ${result.tokenBudget}',
                            style: TextStyle(
                              fontWeight: FontWeight.w600,
                              color: overBudget
                                  ? Theme.of(context).colorScheme.error
                                  : null,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: LinearProgressIndicator(
                          value: result.tokenBudget > 0
                              ? (usedTokens / result.tokenBudget).clamp(0.0, 1.0)
                              : 0,
                          minHeight: 8,
                          color: overBudget
                              ? Theme.of(context).colorScheme.error
                              : null,
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    children: [
                      for (final kind in _kindOrder)
                        ..._buildSection(
                          kind,
                          result.sources.where((s) => s.kind == kind).toList(),
                          enabled,
                        ),
                    ],
                  ),
                ),
                SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
                    child: FilledButton(
                      onPressed: () => Navigator.pop(
                        context,
                        enabled.entries
                            .where((e) => e.value)
                            .map((e) => e.key)
                            .toList(),
                      ),
                      child: const Text('Session starten'),
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  List<Widget> _buildSection(
    String kind,
    List<ContextSource> sources,
    Map<String, bool> enabled,
  ) {
    if (sources.isEmpty) return const [];
    // The active-context source is pinned: always on, no toggle shown —
    // mirrors realtime-token/route.ts always including it server-side.
    final locked = kind == 'active_context';
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(8, 16, 8, 4),
        child: Text(
          _kindLabels[kind] ?? kind,
          style: Theme.of(context).textTheme.labelSmall?.copyWith(
                letterSpacing: 1.2,
                fontWeight: FontWeight.w700,
              ),
        ),
      ),
      Card(
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            for (var i = 0; i < sources.length; i++) ...[
              SwitchListTile(
                value: locked ? true : (enabled[sources[i].id] ?? false),
                onChanged: locked
                    ? null
                    : (value) => setState(() => enabled[sources[i].id] = value),
                title: Text(sources[i].label),
                subtitle: sources[i].meta.isNotEmpty
                    ? Text(
                        sources[i].meta,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      )
                    : null,
                secondary: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.primaryContainer,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    '${sources[i].tokenCount}',
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                ),
              ),
              if (i < sources.length - 1) const Divider(height: 1, indent: 16),
            ],
          ],
        ),
      ),
    ];
  }
}
