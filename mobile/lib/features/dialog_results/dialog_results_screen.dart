import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api/dialog_results_client.dart';

/// Ergebnisse: shown after a Dialog-Session ends. Polls until the
/// Segmentation/Extraction pipeline finishes, then lists the created
/// memory items, distinguishing ones the user explicitly directed from
/// ones the pipeline found passively — with a "Erledigt" action for
/// eligible open items.
class DialogResultsScreen extends StatefulWidget {
  const DialogResultsScreen({super.key, required this.dialogSessionId});

  final String dialogSessionId;

  @override
  State<DialogResultsScreen> createState() => _DialogResultsScreenState();
}

class _DialogResultsScreenState extends State<DialogResultsScreen> {
  final _client = DialogResultsClient();
  Timer? _pollTimer;
  final _pollStartedAt = DateTime.now();
  List<ResultItem>? _items;
  String? _error;
  bool _timedOut = false;

  static const _pollInterval = Duration(seconds: 2);
  static const _pollTimeout = Duration(seconds: 60);

  @override
  void initState() {
    super.initState();
    unawaited(_poll());
    _pollTimer = Timer.periodic(_pollInterval, (_) => _poll());
  }

  Future<void> _poll() async {
    if (!mounted) return;
    final elapsed = DateTime.now().difference(_pollStartedAt) > _pollTimeout;
    try {
      final response = await _client.fetchResults(widget.dialogSessionId);
      if (!mounted) return;
      if (response.status == 'fertig') {
        _pollTimer?.cancel();
        setState(() => _items = response.items);
      } else if (response.status == 'fehlgeschlagen') {
        _pollTimer?.cancel();
        setState(() => _error = 'Die Verarbeitung dieser Session ist fehlgeschlagen.');
      } else if (elapsed) {
        _pollTimer?.cancel();
        setState(() => _timedOut = true);
      }
    } catch (error) {
      if (!mounted) return;
      if (elapsed) {
        _pollTimer?.cancel();
        setState(() => _error = 'Ergebnisse konnten nicht geladen werden: $error');
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
      await _client.markCompleted(original.id);
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
    return Scaffold(
      appBar: AppBar(
        title: const Text('Ergebnisse'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Fertig'),
          ),
        ],
      ),
      body: SafeArea(child: _buildBody()),
    );
  }

  Widget _buildBody() {
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_error!, textAlign: TextAlign.center),
        ),
      );
    }
    final items = _items;
    if (items == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 16),
            Text(
              _timedOut
                  ? 'Verarbeitung dauert länger als erwartet …'
                  : 'Ergebnisse werden verarbeitet …',
            ),
          ],
        ),
      );
    }
    if (items.isEmpty) {
      return const Center(child: Text('Keine Ergebnisse aus dieser Session.'));
    }
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) => _ResultCard(
        item: items[index],
        onMarkCompleted: () => _markCompleted(index),
      ),
    );
  }
}

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.item, required this.onMarkCompleted});

  final ResultItem item;
  final VoidCallback onMarkCompleted;

  static const _eligibleTypes = {'aufgabe', 'offene_frage', 'termin'};

  @override
  Widget build(BuildContext context) {
    final canComplete =
        _eligibleTypes.contains(item.type) && item.status == 'aktiv';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: item.userDirected
                        ? Theme.of(context).colorScheme.primaryContainer
                        : Theme.of(context)
                            .colorScheme
                            .surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    item.userDirected ? 'Auf Wunsch gemerkt' : 'Automatisch erkannt',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
                const SizedBox(width: 8),
                Text(item.type, style: Theme.of(context).textTheme.labelSmall),
                if (item.status == 'erledigt') ...[
                  const SizedBox(width: 8),
                  Icon(
                    Icons.check_circle,
                    size: 16,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                ],
              ],
            ),
            const SizedBox(height: 8),
            Text(item.content),
            if (canComplete) ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: onMarkCompleted,
                  child: const Text('Erledigt'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
