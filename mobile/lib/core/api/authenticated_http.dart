import 'dart:async';

import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';

typedef AuthenticatedRequest = Future<http.Response> Function(
  Map<String, String> headers,
);

const _requestTimeout = Duration(seconds: 15);
Future<Session?>? _refreshInFlight;

Future<Session?> _refreshSession() {
  final runningRefresh = _refreshInFlight;
  if (runningRefresh != null) return runningRefresh;

  final refresh = Supabase.instance.client.auth
      .refreshSession()
      .timeout(_requestTimeout)
      .then((response) => response.session);
  _refreshInFlight = refresh;
  return refresh.whenComplete(() {
    if (identical(_refreshInFlight, refresh)) {
      _refreshInFlight = null;
    }
  });
}

/// Sends an authenticated backend request and retries it once after a 401.
///
/// Supabase can restore or refresh the session just after the app shell becomes
/// visible. Concurrent 401 responses share one refresh operation so the same
/// refresh token is never exchanged twice in parallel.
Future<http.Response> sendAuthenticated(
  AuthenticatedRequest request, {
  Map<String, String> headers = const {},
}) async {
  var session = Supabase.instance.client.auth.currentSession;
  if (session == null) {
    throw StateError('No Supabase session - user must be logged in.');
  }

  Future<http.Response> send(Session currentSession) => request({
        ...headers,
        'Authorization': 'Bearer ${currentSession.accessToken}',
      }).timeout(_requestTimeout);

  var response = await send(session);
  if (response.statusCode != 401) return response;

  session = await _refreshSession();
  if (session == null) {
    throw StateError('Supabase session could not be refreshed.');
  }
  return send(session);
}
