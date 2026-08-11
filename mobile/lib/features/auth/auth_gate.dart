import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../dialog_session/dialog_session_screen.dart';
import 'login_screen.dart';

/// Switches between the login screen and the Dialog-Session screen based on
/// Supabase auth state. EphemeralTokenClient (core/api) requires a signed-in
/// session before it can mint a Realtime token, so nothing dialog-related is
/// reachable while signed out.
class AuthGate extends StatelessWidget {
  const AuthGate({super.key});

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<AuthState>(
      stream: Supabase.instance.client.auth.onAuthStateChange,
      initialData: AuthState(
        AuthChangeEvent.initialSession,
        Supabase.instance.client.auth.currentSession,
      ),
      builder: (context, snapshot) {
        final session = snapshot.data?.session ??
            Supabase.instance.client.auth.currentSession;
        return session == null
            ? const LoginScreen()
            : const DialogSessionScreen();
      },
    );
  }
}
