import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';

import 'ephemeral_token_client.dart' show HttpException;

/// A memory item created from a Dialog-Session, shown on the Ergebnisse
/// screen after the session finished processing.
class ResultItem {
  const ResultItem({
    required this.id,
    required this.type,
    required this.content,
    required this.status,
    required this.confidence,
    required this.userDirected,
    required this.createdAt,
  });

  final String id;
  final String type;
  final String content;
  final String status;
  final String? confidence;
  final bool userDirected;
  final DateTime createdAt;

  factory ResultItem.fromJson(Map<String, dynamic> json) => ResultItem(
        id: json['id'] as String,
        type: json['type'] as String,
        content: json['content'] as String,
        status: json['status'] as String,
        confidence: json['confidence'] as String?,
        userDirected: json['userDirected'] as bool? ?? false,
        createdAt: DateTime.parse(json['createdAt'] as String),
      );

  ResultItem copyWith({String? status}) => ResultItem(
        id: id,
        type: type,
        content: content,
        status: status ?? this.status,
        confidence: confidence,
        userDirected: userDirected,
        createdAt: createdAt,
      );
}

/// `status` mirrors dialog_sessions.processing_status ('laeuft'/'fertig'/
/// 'fehlgeschlagen') — 'fertig' is the only state with populated `items`.
class DialogResultsResponse {
  const DialogResultsResponse({required this.status, required this.items});

  final String status;
  final List<ResultItem> items;
}

/// Fetches a Dialog-Session's extracted results
/// (web/src/app/api/dialog-sessions/[id]/results) and marks user-directed
/// aufgabe/offene_frage/termin items as done
/// (web/src/app/api/memory-items/[id]/status).
class DialogResultsClient {
  DialogResultsClient({String? backendBaseUrl})
      : _backendBaseUrl = backendBaseUrl ??
            const String.fromEnvironment(
              'BACKEND_BASE_URL',
              defaultValue: 'http://localhost:3000',
            );

  final String _backendBaseUrl;

  Future<DialogResultsResponse> fetchResults(String dialogSessionId) async {
    final session = Supabase.instance.client.auth.currentSession;
    if (session == null) {
      throw StateError('No Supabase session — user must be logged in.');
    }

    final response = await http.get(
      Uri.parse('$_backendBaseUrl/api/dialog-sessions/$dialogSessionId/results'),
      headers: {'Authorization': 'Bearer ${session.accessToken}'},
    );

    // 409 is an expected polling state ("not processed yet"/"failed"), not
    // a transport failure — the backend still sends a `status` field in the
    // body, which is exactly what the poller in DialogResultsScreen needs.
    if (response.statusCode == 200 || response.statusCode == 409) {
      final body = jsonDecode(response.body) as Map<String, dynamic>;
      return DialogResultsResponse(
        status: body['status'] as String? ?? 'laeuft',
        items: (body['items'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(ResultItem.fromJson)
            .toList(),
      );
    }

    throw HttpException(
      'Ergebnisse konnten nicht geladen werden (${response.statusCode}): '
      '${response.body}',
    );
  }

  Future<void> markCompleted(String memoryItemId) async {
    final session = Supabase.instance.client.auth.currentSession;
    if (session == null) {
      throw StateError('No Supabase session — user must be logged in.');
    }

    final response = await http.post(
      Uri.parse('$_backendBaseUrl/api/memory-items/$memoryItemId/status'),
      headers: {
        'Authorization': 'Bearer ${session.accessToken}',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'status': 'erledigt'}),
    );

    if (response.statusCode != 200) {
      throw HttpException(
        'Als erledigt markieren fehlgeschlagen (${response.statusCode}): '
        '${response.body}',
      );
    }
  }
}
