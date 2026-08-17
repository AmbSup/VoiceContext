import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';

import 'ephemeral_token_client.dart' show HttpException;

class ActiveContext {
  const ActiveContext({required this.id, required this.name});

  final String id;
  final String name;

  factory ActiveContext.fromJson(Map<String, dynamic> json) => ActiveContext(
        id: json['id'] as String,
        name: json['name'] as String,
      );
}

class ActiveContextResolution {
  const ActiveContextResolution({
    required this.status,
    this.context,
    this.candidates = const [],
  });

  final String status;
  final ActiveContext? context;
  final List<String> candidates;
}

class ActiveContextClient {
  ActiveContextClient({String? backendBaseUrl})
      : _backendBaseUrl = backendBaseUrl ??
            const String.fromEnvironment(
              'BACKEND_BASE_URL',
              defaultValue: 'http://localhost:3000',
            );

  final String _backendBaseUrl;
  static const _requestTimeout = Duration(seconds: 15);

  Future<ActiveContextResolution> resolve(String contextName) async {
    final body = await _post({
      'action': 'resolve',
      'context_name': contextName,
    });
    final contextJson = body['context'];
    return ActiveContextResolution(
      status: body['status'] as String? ?? 'not_found',
      context: contextJson is Map<String, dynamic>
          ? ActiveContext.fromJson(contextJson)
          : null,
      candidates: (body['candidates'] as List<dynamic>? ?? const [])
          .whereType<String>()
          .toList(),
    );
  }

  Future<ActiveContext> confirm(String contextId) async {
    final body = await _post({
      'action': 'confirm',
      'context_id': contextId,
    });
    return ActiveContext.fromJson(
      body['active_context'] as Map<String, dynamic>,
    );
  }

  /// Deselects the default context entirely (no row = no default, see
  /// api/active-context/route.ts's "clear" action) — used by the Kontext
  /// tab's direct-tap picker, as opposed to [confirm]/[resolve] which back
  /// the voice-driven propose/confirm flow.
  Future<void> clear() async {
    await _post({'action': 'clear'});
  }

  Future<Map<String, dynamic>> _post(Map<String, dynamic> body) async {
    final session = Supabase.instance.client.auth.currentSession;
    if (session == null) {
      throw StateError('No Supabase session — user must be logged in.');
    }
    final response = await http
        .post(
          Uri.parse('$_backendBaseUrl/api/active-context'),
          headers: {
            'Authorization': 'Bearer ${session.accessToken}',
            'Content-Type': 'application/json',
          },
          body: jsonEncode(body),
        )
        .timeout(_requestTimeout);
    if (response.statusCode != 200) {
      throw HttpException(
        'Aktiver Kontext fehlgeschlagen (${response.statusCode}): '
        '${response.body}',
      );
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }
}
