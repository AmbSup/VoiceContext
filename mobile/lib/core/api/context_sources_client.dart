import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';

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
  static const _requestTimeout = Duration(seconds: 15);

  Future<ContextSourcesResult> fetchSources() async {
    final session = Supabase.instance.client.auth.currentSession;
    if (session == null) {
      throw StateError('No Supabase session — user must be logged in.');
    }

    final response = await http.get(
      Uri.parse('$_backendBaseUrl/api/context-sources'),
      headers: {'Authorization': 'Bearer ${session.accessToken}'},
    ).timeout(_requestTimeout);

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
      defaultEnabledSourceIds: (body['defaultEnabledSourceIds'] as List<dynamic>? ?? const [])
          .whereType<String>()
          .toList(),
      tokenBudget: body['tokenBudget'] as int? ?? 0,
    );
  }
}
