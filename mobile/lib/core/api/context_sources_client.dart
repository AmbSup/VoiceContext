import 'dart:convert';

import 'package:http/http.dart' as http;

import 'authenticated_http.dart';
import 'ephemeral_token_client.dart' show HttpException;

/// One selectable source for the Turn-Kontext-Auswahl screen: the confirmed
/// active context, another context, a linked document, or a recent session.
class ContextSource {
  const ContextSource({
    required this.id,
    required this.kind,
    required this.label,
    required this.meta,
    required this.tokenCount,
    required this.defaultEnabled,
  });

  final String id;
  final String kind;
  final String label;
  final String meta;
  final int tokenCount;
  final bool defaultEnabled;

  factory ContextSource.fromJson(Map<String, dynamic> json) => ContextSource(
        id: json['id'] as String,
        kind: json['kind'] as String,
        label: json['label'] as String,
        meta: json['meta'] as String? ?? '',
        tokenCount: json['tokenCount'] as int? ?? 0,
        defaultEnabled: json['defaultEnabled'] as bool? ?? false,
      );
}

class ContextSourcesResult {
  const ContextSourcesResult({
    required this.sources,
    required this.defaultEnabledSourceIds,
    required this.tokenBudget,
  });

  final List<ContextSource> sources;
  final List<String> defaultEnabledSourceIds;
  final int tokenBudget;
}

/// Fetches the Turn-Kontext-Auswahl source list from our backend
/// (web/src/app/api/context-sources) — shown before a Dialog-Session starts.
class ContextSourcesClient {
  ContextSourcesClient({String? backendBaseUrl})
      : _backendBaseUrl = backendBaseUrl ??
            const String.fromEnvironment(
              'BACKEND_BASE_URL',
              defaultValue: 'http://localhost:3000',
            );

  final String _backendBaseUrl;

  Future<ContextSourcesResult> fetchSources() async {
    final response = await sendAuthenticated(
      (headers) => http.get(
        Uri.parse('$_backendBaseUrl/api/context-sources'),
        headers: headers,
      ),
    );

    if (response.statusCode != 200) {
      throw HttpException(
        'Kontextquellen konnten nicht geladen werden (${response.statusCode}): '
        '${response.body}',
      );
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return ContextSourcesResult(
      sources: (body['sources'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(ContextSource.fromJson)
          .toList(),
      defaultEnabledSourceIds:
          (body['defaultEnabledSourceIds'] as List<dynamic>? ?? const [])
              .whereType<String>()
              .toList(),
      tokenBudget: body['tokenBudget'] as int? ?? 0,
    );
  }

  /// Freshly rendered Realtime instructions text for [enabledSourceIds] —
  /// used to push a live context change to an already-running Dialog-Session
  /// (see RealtimeDialogController.updateInstructions). `content` never
  /// reaches the client via [fetchSources] on purpose, so the text has to
  /// be built server-side.
  Future<String> fetchInstructions(List<String> enabledSourceIds) async {
    final response = await sendAuthenticated(
      (headers) => http.post(
        Uri.parse('$_backendBaseUrl/api/context-sources/instructions'),
        headers: headers,
        body: jsonEncode({'enabledSourceIds': enabledSourceIds}),
      ),
      headers: const {'Content-Type': 'application/json'},
    );

    if (response.statusCode != 200) {
      throw HttpException(
        'Kontext-Aktualisierung fehlgeschlagen (${response.statusCode}): '
        '${response.body}',
      );
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return body['instructions'] as String;
  }
}
