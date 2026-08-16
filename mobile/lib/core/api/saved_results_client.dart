import 'dart:convert';

import 'package:http/http.dart' as http;

import 'authenticated_http.dart';
import 'ephemeral_token_client.dart' show HttpException;

class SavedResult {
  const SavedResult({
    required this.id,
    required this.kind,
    required this.title,
    required this.content,
    required this.status,
    required this.createdAt,
    this.recipient,
    this.dueAt,
    this.contextName,
    this.sessionStartedAt,
  });

  final String id;
  final String kind;
  final String title;
  final String content;
  final String status;
  final DateTime createdAt;
  final String? recipient;
  final DateTime? dueAt;
  final String? contextName;
  final DateTime? sessionStartedAt;

  factory SavedResult.fromJson(Map<String, dynamic> json) => SavedResult(
        id: json['id'] as String,
        kind: json['kind'] as String,
        title: json['title'] as String,
        content: json['content'] as String,
        status: json['status'] as String,
        createdAt: DateTime.parse(json['createdAt'] as String),
        recipient: json['recipient'] as String?,
        dueAt: json['dueAt'] == null
            ? null
            : DateTime.parse(json['dueAt'] as String),
        contextName: json['contextName'] as String?,
        sessionStartedAt: json['sessionStartedAt'] == null
            ? null
            : DateTime.parse(json['sessionStartedAt'] as String),
      );

  SavedResult copyWith({String? status}) => SavedResult(
        id: id,
        kind: kind,
        title: title,
        content: content,
        status: status ?? this.status,
        createdAt: createdAt,
        recipient: recipient,
        dueAt: dueAt,
        contextName: contextName,
        sessionStartedAt: sessionStartedAt,
      );
}

class SavedResultsClient {
  SavedResultsClient({String? backendBaseUrl})
      : _backendBaseUrl = backendBaseUrl ??
            const String.fromEnvironment(
              'BACKEND_BASE_URL',
              defaultValue: 'http://localhost:3000',
            );

  final String _backendBaseUrl;

  Future<List<SavedResult>> fetchResults({String? dialogSessionId}) async {
    final uri = Uri.parse('$_backendBaseUrl/api/saved-results').replace(
      queryParameters: dialogSessionId == null
          ? null
          : {'dialog_session_id': dialogSessionId},
    );
    final response = await sendAuthenticated(
      (headers) => http.get(uri, headers: headers),
    );
    if (response.statusCode != 200) {
      throw HttpException(
        'Ergebnisse konnten nicht geladen werden (${response.statusCode}): '
        '${response.body}',
      );
    }
    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return (body['items'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(SavedResult.fromJson)
        .toList();
  }

  Future<SavedResult> create({
    required String dialogSessionId,
    required String kind,
    required String title,
    required String content,
    String? contextId,
    String? recipient,
    String? dueAt,
  }) async {
    final response = await sendAuthenticated(
      (headers) => http.post(
        Uri.parse('$_backendBaseUrl/api/saved-results'),
        headers: headers,
        body: jsonEncode({
          'dialogSessionId': dialogSessionId,
          'kind': kind,
          'title': title,
          'content': content,
          if (contextId != null) 'contextId': contextId,
          if (recipient != null) 'recipient': recipient,
          if (dueAt != null) 'dueAt': dueAt,
        }),
      ),
      headers: const {'Content-Type': 'application/json'},
    );
    if (response.statusCode != 201) {
      throw HttpException(
        'Ergebnis konnte nicht gespeichert werden (${response.statusCode}): '
        '${response.body}',
      );
    }
    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return SavedResult.fromJson(body['item'] as Map<String, dynamic>);
  }

  Future<void> updateStatus(String id, String status) async {
    final response = await sendAuthenticated(
      (headers) => http.patch(
        Uri.parse('$_backendBaseUrl/api/saved-results/$id'),
        headers: headers,
        body: jsonEncode({'status': status}),
      ),
      headers: const {'Content-Type': 'application/json'},
    );
    if (response.statusCode != 200) {
      throw HttpException(
        'Status konnte nicht geändert werden (${response.statusCode}): '
        '${response.body}',
      );
    }
  }
}
