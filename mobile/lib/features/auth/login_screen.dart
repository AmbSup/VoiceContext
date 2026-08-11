import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// Email+password sign-in/sign-up. AuthGate swaps this out for the
/// Dialog-Session screen as soon as Supabase reports a session.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _submit({required bool signUp}) async {
    if (!(_formKey.currentState?.validate() ?? false)) {
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final auth = Supabase.instance.client.auth;
      if (signUp) {
        await auth.signUp(
          email: _emailController.text.trim(),
          password: _passwordController.text,
        );
      } else {
        await auth.signInWithPassword(
          email: _emailController.text.trim(),
          password: _passwordController.text,
        );
      }
      // AuthGate reacts to the resulting auth state change; nothing else
      // to do here on success.
    } on AuthException catch (error) {
      setState(() => _error = error.message);
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('KI Voice Context Engine')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Form(
              key: _formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextFormField(
                    controller: _emailController,
                    keyboardType: TextInputType.emailAddress,
                    decoration: const InputDecoration(labelText: 'E-Mail'),
                    validator: (value) => (value == null || !value.contains('@'))
                        ? 'Bitte eine gültige E-Mail eingeben'
                        : null,
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _passwordController,
                    obscureText: true,
                    decoration: const InputDecoration(labelText: 'Passwort'),
                    validator: (value) => (value == null || value.length < 6)
                        ? 'Mindestens 6 Zeichen'
                        : null,
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      _error!,
                      style: TextStyle(color: Theme.of(context).colorScheme.error),
                    ),
                  ],
                  const SizedBox(height: 20),
                  Row(
                    children: [
                      Expanded(
                        child: FilledButton(
                          onPressed: _submitting ? null : () => _submit(signUp: false),
                          child: const Text('Anmelden'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: OutlinedButton(
                          onPressed: _submitting ? null : () => _submit(signUp: true),
                          child: const Text('Registrieren'),
                        ),
                      ),
                    ],
                  ),
                  if (_submitting) ...[
                    const SizedBox(height: 16),
                    const CircularProgressIndicator(),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
