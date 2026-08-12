import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';

import 'ephemeral_token_client.dart' show HttpException;

/// Live-targeted Retrieval for the Realtime dialog's "Antworten" state (see
/// docs/implementation-plan.md Phase 2 step 3). Called by
/// RealtimeDialogController when the model invokes the retrieve_memory
/// function tool (see the `tools` config in
/// web/src/app/api/realtime-token/route.ts). Returns raw memory items —
/// the Realtime model itself speaks the grounded answer, there's no
/// answer-synthesis step here (unlike web/src/app/search).
class RetrievalClient {
  RetrievalClient({String? backendBaseUrl})
      : _backendBaseUrl = backendBaseUrl ??
            const String.fromEnvironment(
              'BACKEND_BASE_URL',
              defaultValue: 'http://localhost:3000',
            );

  final String _backendBaseUrl;

  Future<List<Map<String, dynamic>>> retrieve(String query) async {
    final session = Supabase.instance.client.auth.currentSession;
    if (session == null) {
      throw StateError('No Supabase session — user must be logged in.');
    }

    final response = await http.post(
      Uri.parse('$_backendBaseUrl/api/retrieve'),
      headers: {
        'Authorization': 'Bearer ${session.accessToken}',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'query': query}),
    );

    if (response.statusCode != 200) {
      throw HttpException(
        'Retrieval fehlgeschlagen (${response.statusCode}): ${response.body}',
      );
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    final items = body['items'] as List<dynamic>? ?? const <dynamic>[];
    return items.cast<Map<String, dynamic>>();
  }

  /// Structured listing for the list_context_items function tool — the
  /// counterpart to [retrieve] above. See
  /// web/src/app/api/list-context-items/route.ts: no similarity ranking,
  /// just every Memory-Item actually linked to the named context.
  Future<Map<String, dynamic>> listContextItems(String contextName) async {
    final session = Supabase.instance.client.auth.currentSession;
    if (session == null) {
      throw StateError('No Supabase session — user must be logged in.');
    }

    final response = await http.post(
      Uri.parse('$_backendBaseUrl/api/list-context-items'),
      headers: {
        'Authorization': 'Bearer ${session.accessToken}',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'context_name': contextName}),
    );

    if (response.statusCode != 200) {
      throw HttpException(
        'Kontext-Auflistung fehlgeschlagen (${response.statusCode}): '
        '${response.body}',
      );
    }

    return jsonDecode(response.body) as Map<String, dynamic>;
  }
}
