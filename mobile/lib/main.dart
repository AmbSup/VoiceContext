import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'core/theme/modernist_colors.dart';
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
    final colorScheme = ColorScheme.fromSeed(
      seedColor: ModernistColors.accent,
      brightness: Brightness.light,
    ).copyWith(
      primary: ModernistColors.accent,
      onPrimary: ModernistColors.bg,
      secondary: ModernistColors.accent2,
      surface: ModernistColors.bg,
      onSurface: ModernistColors.text,
      outline: ModernistColors.divider,
    );
    return MaterialApp(
      title: 'KI Voice Context Engine',
      theme: ThemeData(
        colorScheme: colorScheme,
        scaffoldBackgroundColor: ModernistColors.bg,
        useMaterial3: true,
        appBarTheme: const AppBarTheme(
          backgroundColor: ModernistColors.bg,
          foregroundColor: ModernistColors.text,
          elevation: 0,
          scrolledUnderElevation: 0,
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: ModernistColors.accent,
            foregroundColor: ModernistColors.bg,
            elevation: 0,
            shape: const RoundedRectangleBorder(),
          ),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            backgroundColor: ModernistColors.accent,
            foregroundColor: ModernistColors.bg,
            shape: const RoundedRectangleBorder(),
          ),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            foregroundColor: ModernistColors.text,
            side: const BorderSide(color: ModernistColors.divider),
            shape: const RoundedRectangleBorder(),
          ),
        ),
        chipTheme: const ChipThemeData(
          shape: RoundedRectangleBorder(),
          side: BorderSide(color: ModernistColors.dividerLight),
        ),
      ),
      home: const AuthGate(),
    );
  }
}
