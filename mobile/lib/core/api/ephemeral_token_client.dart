import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';

import 'active_context_client.dart';

class RealtimeToken {
  RealtimeToken({
    required this.token,
    required this.expiresAt,
    this.realtimeEndpoint,
    this.activeContext,
    this.displayName,
  });

  final String token;
  final DateTime expiresAt;
  final Uri? realtimeEndpoint;
  final ActiveContext? activeContext;

  /// The user's `profiles.display_name` (see settings_tab.dart), for the
  /// Realtime session's opening greeting — null if never set.
  final String? displayName;
}

/// Fetches a short-lived OpenAI Realtime API token from our backend
/// (web/src/app/api/realtime-token). The OpenAI master key lives only on
/// the backend — the app never sees it, only this per-session token.
class EphemeralTokenClient {
  EphemeralTokenClient({String? backendBaseUrl})
      : _backendBaseUrl = backendBaseUrl ??
            const String.fromEnvironment(
              'BACKEND_BASE_URL',
              defaultValue: 'http://localhost:3000',
            );

  final String _backendBaseUrl;

  /// [enabledSourceIds] comes from the Turn-Kontext-Auswahl screen (see
  /// ContextSelectionScreen) — the context-sources ids the user left toggled
  /// on before starting this session. Omit it (or pass null) to let the
  /// backend fall back to its own default source scope.
  Future<RealtimeToken> fetchEphemeralToken({
    List<String>? enabledSourceIds,
  }) async {
    final session = Supabase.instance.client.auth.currentSession;
    if (session == null) {
      throw StateError('No Supabase session — user must be logged in.');
    }

    final response = await http.post(
      Uri.parse('$_backendBaseUrl/api/realtime-token'),
      headers: {
        'Authorization': 'Bearer ${session.accessToken}',
        if (enabledSourceIds != null) 'Content-Type': 'application/json',
      },
      body: enabledSourceIds != null
          ? jsonEncode({'enabledSourceIds': enabledSourceIds})
          : null,
    );

    if (response.statusCode != 200) {
      throw HttpException(
        'Failed to fetch Realtime token (${response.statusCode}): ${response.body}',
      );
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return RealtimeToken(
      token: body['token'] as String,
      expiresAt: DateTime.fromMillisecondsSinceEpoch(
        (body['expiresAt'] as int) * 1000,
      ),
      realtimeEndpoint: switch (body['realtimeUrl']) {
        final String url => Uri.parse(url),
        _ => null,
      },
      activeContext: switch (body['activeContext']) {
        final Map<String, dynamic> value => ActiveContext.fromJson(value),
        _ => null,
      },
      displayName: body['displayName'] as String?,
    );
  }
}

class HttpException implements Exception {
  HttpException(this.message);
  final String message;

  @override
  String toString() => message;
}
