import 'package:flutter/material.dart';

/// Color/shape tokens from the "Modernist" design system the
/// Turn-Kontext-Auswahl and Ergebnisse mockups were built in (Claude
/// Design project "AI Talking App Context Management"). Flat and
/// sharp-cornered — no elevation, no rounded corners — with a red-orange
/// accent instead of Material's default purple. Not applied app-wide yet,
/// only to the two screens built from that mockup.
class ModernistColors {
  const ModernistColors._();

  static const bg = Color(0xFFF3F2F2);
  static const surface = Color(0xFFEAE9E9);
  static const text = Color(0xFF201E1D);
  static const textMuted = Color(0x8C201E1D); // ~55% alpha
  static const textFaint = Color(0x73201E1D); // ~45% alpha
  static const divider = Color(0x66201E1D); // ~40% alpha — thick section rules
  static const dividerLight = Color(0x2E201E1D); // ~18% alpha — row rules
  static const trackBg = Color(0x1F201E1D); // ~12% alpha — progress track
  static const accent = Color(0xFFEC3013);
  static const accent2 = Color(0xFFE15B47);
  static const accentDark = Color(0xFFAE1800);
  static const accentTintBg = Color(0xFFFFE0D9);
  static const selectedRowBg = Color(0xFFFFF2EF);
  static const neutralTintBg = Color(0x1A201E1D); // ~10% alpha
}
