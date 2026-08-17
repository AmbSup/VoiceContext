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

  // Both function tools ride the live turn-taking latency budget — the user
  // is waiting mid-conversation. Without a bound, a stalled OpenAI-embedding
  // call or Supabase query on the backend leaves this await pending forever,
  // so the existing error handling in RealtimeDialogController (which reports
  // failures back to the model so it can say something) never triggers.
  static const _requestTimeout = Duration(seconds: 15);
  static const _webSearchTimeout = Duration(seconds: 12);

  /// context_name/memory_type/occurred_from/occurred_to/scope are optional
  /// Metadatenfilter (see the retrieve_memory function tool's parameters in
  /// web/src/app/api/realtime-token/route.ts) — only forwarded when set, so
  /// the backend's hybrid retrieval falls back to its unfiltered default.
  /// scope: "context_space" skips the active-context/context_name scoping
  /// entirely for an explicit cross-cutting search; unset/"active_context"
  /// is today's unchanged behavior.
  ///
  /// Returns the full decoded response body, not just `items` — an
  /// ambiguous context_name comes back as `{'items': [], 'ambiguous_context':
  /// {...}}` (see api/retrieve/route.ts), and callers need that field to
  /// pass the ambiguity back to the model instead of it being silently
  /// dropped here.
  Future<Map<String, dynamic>> retrieve(
    String query, {
    String? contextName,
    String? memoryType,
    String? occurredFrom,
    String? occurredTo,
    String? scope,
  }) async {
    final session = Supabase.instance.client.auth.currentSession;
    if (session == null) {
      throw StateError('No Supabase session — user must be logged in.');
    }

    final response = await http
        .post(
          Uri.parse('$_backendBaseUrl/api/retrieve'),
          headers: {
            'Authorization': 'Bearer ${session.accessToken}',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({
            'query': query,
            if (contextName != null) 'context_name': contextName,
            if (memoryType != null) 'type': memoryType,
            if (occurredFrom != null) 'occurred_from': occurredFrom,
            if (occurredTo != null) 'occurred_to': occurredTo,
            if (scope != null) 'scope': scope,
          }),
        )
        .timeout(_requestTimeout);

    if (response.statusCode != 200) {
      throw HttpException(
        'Retrieval fehlgeschlagen (${response.statusCode}): ${response.body}',
      );
    }

    return jsonDecode(response.body) as Map<String, dynamic>;
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

    final response = await http
        .post(
          Uri.parse('$_backendBaseUrl/api/list-context-items'),
          headers: {
            'Authorization': 'Bearer ${session.accessToken}',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({'context_name': contextName}),
        )
        .timeout(_requestTimeout);

    if (response.statusCode != 200) {
      throw HttpException(
        'Kontext-Auflistung fehlgeschlagen (${response.statusCode}): '
        '${response.body}',
      );
    }

    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<String> searchWeb(String query) async {
    final session = Supabase.instance.client.auth.currentSession;
    if (session == null) {
      throw StateError('No Supabase session — user must be logged in.');
    }

    final response = await http
        .post(
          Uri.parse('$_backendBaseUrl/api/web-search'),
          headers: {
            'Authorization': 'Bearer ${session.accessToken}',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({'query': query}),
        )
        .timeout(_webSearchTimeout);

    if (response.statusCode != 200) {
      throw HttpException(
        'Websuche fehlgeschlagen (${response.statusCode}): ${response.body}',
      );
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return body['answer'] as String? ?? '';
  }
}
