import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api/dialog_results_client.dart';
import '../../core/api/saved_results_client.dart';
import '../../core/theme/modernist_colors.dart';

/// Ergebnisse tab: shows the most recently ended Dialog-Session's results —
/// both what the extraction pipeline found (memory items, polled until
/// processing finishes) and what the user explicitly saved live during the
/// conversation via the save_result Realtime tool (email drafts, tasks,
/// questions for later — see RealtimeDialogController._handleSaveResult).
/// The latter don't need polling: they're written synchronously as the
/// session happens, so they're fetched once and shown immediately.
///
/// [dialogSessionId] is null until a session has ended in this app run —
/// MainShell passes it a fresh `ValueKey(dialogSessionId)` each time a new
/// session ends, so this widget's State (and its poll Timer) is rebuilt
/// from scratch for the new session while a mere tab switch (same id)
/// leaves it untouched.
///
/// Styled after the "Modernist" Claude Design mockup this screen was built
/// from: flat, sharp-cornered, thick-rule sections, red-orange accent —
/// deliberately not Material defaults.
class ErgebnisseTab extends StatefulWidget {
  const ErgebnisseTab({super.key, required this.dialogSessionId});

  final String? dialogSessionId;

  @override
  State<ErgebnisseTab> createState() => _ErgebnisseTabState();
}

class _ErgebnisseTabState extends State<ErgebnisseTab> {
  final _resultsClient = DialogResultsClient();
  final _savedResultsClient = SavedResultsClient();
  Timer? _pollTimer;
  final _pollStartedAt = DateTime.now();
  List<ResultItem>? _items;
  String? _error;
  bool _timedOut = false;
  List<SavedResult>? _savedResults;
  bool _savedResultsLoading = false;
  String? _savedResultsError;
  final _selectedSavedIds = <String>{};

  static const _pollInterval = Duration(seconds: 2);
  static const _pollTimeout = Duration(seconds: 60);

  @override
  void initState() {
    super.initState();
    unawaited(_loadSavedResults());
    if (widget.dialogSessionId != null) {
      unawaited(_poll());
      _pollTimer = Timer.periodic(_pollInterval, (_) => _poll());
    }
  }

  Future<void> _loadSavedResults() async {
    if (_savedResultsLoading) return;
    setState(() {
      _savedResultsLoading = true;
      _savedResultsError = null;
    });
    try {
      final results = await _savedResultsClient.fetchResults();
      if (mounted) setState(() => _savedResults = results);
    } catch (error) {
      debugPrint(
          'Gespeicherte Ergebnisse konnten nicht geladen werden: $error');
      if (mounted) {
        setState(() {
          _savedResultsError =
              'Gespeicherte Ergebnisse konnten nicht geladen werden.';
        });
      }
    } finally {
      if (mounted) setState(() => _savedResultsLoading = false);
    }
  }

  Future<void> _markSavedCompleted(int index) async {
    final results = _savedResults;
    if (results == null) return;
    final original = results[index];
    setState(() => results[index] = original.copyWith(status: 'erledigt'));
    try {
      await _savedResultsClient.updateStatus(original.id, 'erledigt');
    } catch (error) {
      if (!mounted) return;
      setState(() => results[index] = original);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Konnte nicht als erledigt markiert werden: $error'),
        ),
      );
    }
  }

  Future<void> _poll() async {
    final dialogSessionId = widget.dialogSessionId;
    if (!mounted || dialogSessionId == null) return;
    final elapsed = DateTime.now().difference(_pollStartedAt) > _pollTimeout;
    try {
      final response = await _resultsClient.fetchResults(dialogSessionId);
      if (!mounted) return;
      if (response.status == 'fertig') {
        _pollTimer?.cancel();
        setState(() => _items = response.items);
      } else if (response.status == 'fehlgeschlagen') {
        _pollTimer?.cancel();
        setState(() =>
            _error = 'Die Verarbeitung dieser Session ist fehlgeschlagen.');
      } else if (elapsed) {
        _pollTimer?.cancel();
        setState(() => _timedOut = true);
      }
    } catch (error) {
      if (!mounted) return;
      if (elapsed) {
        _pollTimer?.cancel();
        setState(
            () => _error = 'Ergebnisse konnten nicht geladen werden: $error');
      }
      // Otherwise: a transient error while still polling — retried on the
      // next tick rather than surfaced immediately.
    }
  }

  Future<void> _markCompleted(int index) async {
    final items = _items;
    if (items == null) return;
    final original = items[index];
    setState(() => items[index] = original.copyWith(status: 'erledigt'));
    try {
      await _resultsClient.markCompleted(original.id);
    } catch (error) {
      if (!mounted) return;
      setState(() => items[index] = original);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Konnte nicht als erledigt markiert werden: $error'),
        ),
      );
    }
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final savedResults = _savedResults ?? const <SavedResult>[];
    final allSelected = savedResults.isNotEmpty &&
        savedResults.every((item) => _selectedSavedIds.contains(item.id));
    return SafeArea(
      child: Column(
        children: [
          _ResultsHeader(
            allSelected: allSelected,
            onSelectAll: () => _toggleAll(savedResults),
          ),
          Expanded(child: _buildBody()),
          _SelectionBar(
            selectedCount: _selectedSavedIds.length,
            onAction: _shareSelection,
          ),
        ],
      ),
    );
  }

  void _toggleAll(List<SavedResult> results) {
    if (results.isEmpty) return;
    setState(() {
      if (results.every((item) => _selectedSavedIds.contains(item.id))) {
        _selectedSavedIds.removeAll(results.map((item) => item.id));
      } else {
        _selectedSavedIds.addAll(results.map((item) => item.id));
      }
    });
  }

  void _toggleSaved(String id) {
    setState(() {
      if (!_selectedSavedIds.add(id)) _selectedSavedIds.remove(id);
    });
  }

  Future<void> _shareSelection(String target) async {
    final results = _savedResults ?? const <SavedResult>[];
    final selected =
        results.where((item) => _selectedSavedIds.contains(item.id)).toList();
    if (selected.isEmpty) return;
    await Clipboard.setData(
      ClipboardData(
        text: selected
            .map((item) => '${item.title}\n${item.content}')
            .join('\n\n'),
      ),
    );
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          '$target vorbereitet: ${selected.length} Punkte wurden kopiert.',
        ),
      ),
    );
  }

  Widget _buildBody() {
    final savedResults = _savedResults;
    final hasSavedResults = savedResults != null && savedResults.isNotEmpty;
    if (widget.dialogSessionId == null && savedResults == null) {
      if (_savedResultsError != null) return _buildSavedResultsError();
      return const Center(
        child: CircularProgressIndicator(color: ModernistColors.accent),
      );
    }
    if (widget.dialogSessionId == null && !hasSavedResults) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'Noch keine Ergebnisse.\n\nSag im Sprachmodus zum Beispiel: „Mach daraus eine Aufgabe.“',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: ModernistColors.textMuted,
              height: 1.5,
            ),
          ),
        ),
      );
    }

    return ListView(
      padding: EdgeInsets.zero,
      children: [
        if (_savedResultsError != null) _buildSavedResultsError(),
        if (_savedResultsLoading && savedResults == null)
          const Padding(
            padding: EdgeInsets.all(20),
            child: Center(
              child: CircularProgressIndicator(color: ModernistColors.accent),
            ),
          ),
        if (hasSavedResults) ...[
          const _SectionHeader('GESPEICHERTE ERGEBNISSE'),
          for (var i = 0; i < savedResults.length; i++) ...[
            _SavedResultRow(
              item: savedResults[i],
              selected: _selectedSavedIds.contains(savedResults[i].id),
              onTap: () => _toggleSaved(savedResults[i].id),
              onMarkCompleted: () => _markSavedCompleted(i),
            ),
            if (i < savedResults.length - 1)
              const Divider(
                  height: 1, thickness: 1, color: ModernistColors.dividerLight),
          ],
          if (widget.dialogSessionId != null)
            const _SectionHeader('AUS DER LETZTEN SESSION EXTRAHIERT'),
        ],
        if (widget.dialogSessionId != null) _buildExtractedResults(),
      ],
    );
  }

  Widget _buildSavedResultsError() => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              _savedResultsError!,
              textAlign: TextAlign.center,
              style: const TextStyle(color: ModernistColors.textMuted),
            ),
            const SizedBox(height: 16),
            OutlinedButton(
              onPressed: _savedResultsLoading ? null : _loadSavedResults,
              child: Text(_savedResultsLoading ? 'LÄDT …' : 'NOCHMALS'),
            ),
          ],
        ),
      );

  Widget _buildExtractedResults() {
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            _error!,
            textAlign: TextAlign.center,
            style: const TextStyle(color: ModernistColors.text),
          ),
        ),
      );
    }
    final items = _items;
    if (items == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(color: ModernistColors.accent),
              const SizedBox(height: 16),
              Text(
                _timedOut
                    ? 'Verarbeitung dauert länger als erwartet …'
                    : 'Ergebnisse werden verarbeitet …',
                style: const TextStyle(color: ModernistColors.textMuted),
              ),
            ],
          ),
        ),
      );
    }
    if (items.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'Keine Ergebnisse aus dieser Session.',
            style: TextStyle(color: ModernistColors.textMuted),
          ),
        ),
      );
    }
    return Column(
      children: [
        for (var i = 0; i < items.length; i++) ...[
          _ResultRow(item: items[i], onMarkCompleted: () => _markCompleted(i)),
          if (i < items.length - 1)
            const Divider(
                height: 1, thickness: 1, color: ModernistColors.dividerLight),
        ],
      ],
    );
  }
}

class _ResultsHeader extends StatelessWidget {
  const _ResultsHeader({
    required this.allSelected,
    required this.onSelectAll,
  });

  final bool allSelected;
  final VoidCallback onSelectAll;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 72,
      padding: const EdgeInsets.symmetric(horizontal: 20),
      decoration: const BoxDecoration(
        border: Border(
          bottom: BorderSide(color: ModernistColors.divider, width: 2),
        ),
      ),
      child: Row(
        children: [
          const Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'ALLE SESSIONS',
                  style: TextStyle(
                    fontSize: 9,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 1.1,
                    color: ModernistColors.textMuted,
                  ),
                ),
                SizedBox(height: 3),
                Text(
                  'Ergebnisse',
                  style: TextStyle(
                    fontSize: 24,
                    height: 1,
                    fontWeight: FontWeight.w800,
                    color: ModernistColors.text,
                  ),
                ),
              ],
            ),
          ),
          OutlinedButton(
            onPressed: onSelectAll,
            style: OutlinedButton.styleFrom(
              foregroundColor: ModernistColors.text,
              side: const BorderSide(color: ModernistColors.divider),
              shape: const RoundedRectangleBorder(),
              padding: const EdgeInsets.symmetric(horizontal: 12),
            ),
            child: Text(
              allSelected ? 'AUSWAHL AUFHEBEN' : 'ALLE WÄHLEN',
              style: const TextStyle(
                fontSize: 9,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.5,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SelectionBar extends StatelessWidget {
  const _SelectionBar({
    required this.selectedCount,
    required this.onAction,
  });

  final int selectedCount;
  final ValueChanged<String> onAction;

  @override
  Widget build(BuildContext context) {
    final enabled = selectedCount > 0;
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 14),
      decoration: const BoxDecoration(
        color: ModernistColors.bg,
        border: Border(
          top: BorderSide(color: ModernistColors.divider, width: 2),
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Text(
                enabled
                    ? '$selectedCount Punkte ausgewählt'
                    : 'Nichts ausgewählt',
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const Spacer(),
              Text(
                enabled ? 'AUSWAHL BLEIBT BIS ZUM TEILEN' : 'ZEILE ANTIPPEN',
                style: const TextStyle(
                  fontSize: 8,
                  letterSpacing: 0.35,
                  color: ModernistColors.textFaint,
                ),
              ),
            ],
          ),
          const SizedBox(height: 9),
          Row(
            children: [
              _shareButton('PER MAIL', enabled),
              const SizedBox(width: 2),
              _shareButton('ALS PDF', enabled),
              const SizedBox(width: 2),
              _shareButton('IN KONTEXT', enabled),
            ],
          ),
        ],
      ),
    );
  }

  Widget _shareButton(String label, bool enabled) => Expanded(
        child: SizedBox(
          height: 34,
          child: FilledButton(
            onPressed: enabled ? () => onAction(label) : null,
            style: FilledButton.styleFrom(
              backgroundColor: ModernistColors.accent,
              disabledBackgroundColor: ModernistColors.neutralTintBg,
              foregroundColor: ModernistColors.bg,
              disabledForegroundColor: ModernistColors.textFaint,
              elevation: 0,
              shape: const RoundedRectangleBorder(),
              padding: EdgeInsets.zero,
            ),
            child: Text(
              label,
              style: const TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ),
      );
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
      decoration: const BoxDecoration(
        border: Border(
          top: BorderSide(color: ModernistColors.divider, width: 2),
          bottom: BorderSide(color: ModernistColors.divider, width: 2),
        ),
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w800,
          letterSpacing: 1.2,
          color: ModernistColors.text,
        ),
      ),
    );
  }
}

class _KindLabels {
  static const email = 'E-MAIL';
  static const aufgabe = 'AUFGABE';
  static const frage = 'FRAGE';
}

class _SavedResultRow extends StatelessWidget {
  const _SavedResultRow({
    required this.item,
    required this.selected,
    required this.onTap,
    required this.onMarkCompleted,
  });

  final SavedResult item;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback onMarkCompleted;

  static const _eligibleStatuses = {'offen', 'wartet'};

  String get _kindLabel => switch (item.kind) {
        'email' => _KindLabels.email,
        'aufgabe' => _KindLabels.aufgabe,
        'frage' => _KindLabels.frage,
        _ => item.kind.toUpperCase(),
      };

  @override
  Widget build(BuildContext context) {
    final canComplete =
        item.kind != 'email' && _eligibleStatuses.contains(item.status);
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
        decoration: BoxDecoration(
          color: selected ? ModernistColors.selectedRowBg : ModernistColors.bg,
          border: selected
              ? const Border(
                  left: BorderSide(color: ModernistColors.accent, width: 3),
                )
              : null,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 16,
                  height: 16,
                  margin: const EdgeInsets.only(right: 12),
                  decoration: BoxDecoration(
                    color:
                        selected ? ModernistColors.accent : Colors.transparent,
                    border: Border.all(
                      color: selected
                          ? ModernistColors.accent
                          : ModernistColors.divider,
                    ),
                  ),
                ),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                  color: ModernistColors.accentTintBg,
                  child: Text(
                    _kindLabel,
                    style: const TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.6,
                      color: ModernistColors.accentDark,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  item.status.toUpperCase(),
                  style: const TextStyle(
                    fontSize: 10,
                    letterSpacing: 0.6,
                    color: ModernistColors.textMuted,
                  ),
                ),
                if (item.status == 'erledigt') ...[
                  const SizedBox(width: 8),
                  const Icon(Icons.check_circle,
                      size: 15, color: ModernistColors.accent),
                ],
              ],
            ),
            const SizedBox(height: 6),
            Text(
              item.title,
              style: const TextStyle(
                fontSize: 14.5,
                fontWeight: FontWeight.w800,
                color: ModernistColors.text,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              item.content,
              style: const TextStyle(
                fontSize: 13.5,
                height: 1.4,
                color: ModernistColors.text,
              ),
            ),
            if (item.recipient != null) ...[
              const SizedBox(height: 4),
              Text(
                'An: ${item.recipient}',
                style: const TextStyle(
                    fontSize: 12, color: ModernistColors.textMuted),
              ),
            ],
            if (canComplete) ...[
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerRight,
                child: SizedBox(
                  height: 36,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: ModernistColors.accent,
                      foregroundColor: ModernistColors.bg,
                      elevation: 0,
                      shape: const RoundedRectangleBorder(),
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                    ),
                    onPressed: onMarkCompleted,
                    child: const Text(
                      'ERLEDIGT',
                      style: TextStyle(
                        fontSize: 12,
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
    );
  }
}

class _ResultRow extends StatelessWidget {
  const _ResultRow({required this.item, required this.onMarkCompleted});

  final ResultItem item;
  final VoidCallback onMarkCompleted;

  static const _eligibleTypes = {'aufgabe', 'offene_frage', 'termin'};

  @override
  Widget build(BuildContext context) {
    final canComplete =
        _eligibleTypes.contains(item.type) && item.status == 'aktiv';
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                color: item.userDirected
                    ? ModernistColors.accentTintBg
                    : ModernistColors.neutralTintBg,
                child: Text(
                  item.userDirected
                      ? 'AUF WUNSCH GEMERKT'
                      : 'AUTOMATISCH ERKANNT',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.6,
                    color: item.userDirected
                        ? ModernistColors.accentDark
                        : ModernistColors.textMuted,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                item.type.toUpperCase(),
                style: const TextStyle(
                  fontSize: 10,
                  letterSpacing: 0.6,
                  color: ModernistColors.textMuted,
                ),
              ),
              if (item.status == 'erledigt') ...[
                const SizedBox(width: 8),
                const Icon(Icons.check_circle,
                    size: 15, color: ModernistColors.accent),
              ],
            ],
          ),
          const SizedBox(height: 8),
          Container(
            padding: item.userDirected
                ? const EdgeInsets.only(left: 10)
                : EdgeInsets.zero,
            decoration: item.userDirected
                ? const BoxDecoration(
                    border: Border(
                      left: BorderSide(color: ModernistColors.accent, width: 2),
                    ),
                  )
                : null,
            child: Text(
              item.content,
              style: const TextStyle(
                fontSize: 14.5,
                height: 1.4,
                color: ModernistColors.text,
              ),
            ),
          ),
          if (canComplete) ...[
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerRight,
              child: SizedBox(
                height: 36,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: ModernistColors.accent,
                    foregroundColor: ModernistColors.bg,
                    elevation: 0,
                    shape: const RoundedRectangleBorder(),
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                  ),
                  onPressed: onMarkCompleted,
                  child: const Text(
                    'ERLEDIGT',
                    style: TextStyle(
                      fontSize: 12,
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
    );
  }
}
