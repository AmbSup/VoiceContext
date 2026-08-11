import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'features/auth/auth_gate.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // EU-region Supabase project from Phase 0 of docs/implementation-plan.md.
  // Pass both at build/run time, e.g.:
  // flutter run --dart-define=SUPABASE_URL=... --dart-define=SUPABASE_ANON_KEY=...
  await Supabase.initialize(
    url: const String.fromEnvironment('SUPABASE_URL'),
    publishableKey: const String.fromEnvironment('SUPABASE_ANON_KEY'),
  );

  runApp(const VoiceContextApp());
}

class VoiceContextApp extends StatelessWidget {
  const VoiceContextApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'KI Voice Context Engine',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: const AuthGate(),
    );
  }
}
