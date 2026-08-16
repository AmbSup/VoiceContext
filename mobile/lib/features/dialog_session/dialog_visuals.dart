import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/theme/modernist_colors.dart';

/// Renders [levels] (oldest to newest, each 0.0-1.0) as a scrolling bar
/// waveform — real mic amplitude from RealtimeDialogController.audioLevels,
/// so a bar visibly rising as soon as the user starts talking is direct,
/// immediate proof that their voice is being captured live.
class AudioWaveform extends StatelessWidget {
  const AudioWaveform({super.key, required this.levels});

  final List<double> levels;

  static const _barWidth = 5.0;
  static const _barSpacing = 3.0;
  static const _maxBarHeight = 44.0;
  static const _minBarHeight = 4.0;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: _maxBarHeight,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          for (final level in levels)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: _barSpacing / 2),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 100),
                width: _barWidth,
                height: _minBarHeight +
                    (level.clamp(0.0, 1.0) * (_maxBarHeight - _minBarHeight)),
                decoration: const BoxDecoration(
                  color: ModernistColors.text,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class ThinkingOrb extends StatefulWidget {
  const ThinkingOrb({super.key});

  @override
  State<ThinkingOrb> createState() => _ThinkingOrbState();
}

class _ThinkingOrbState extends State<ThinkingOrb>
    with SingleTickerProviderStateMixin {
  late final AnimationController _animation;

  @override
  void initState() {
    super.initState();
    _animation = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2400),
    )..repeat();
  }

  @override
  void dispose() {
    _animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? const [Color(0xFF7C4DFF), Color(0xFF00E5FF), Color(0xFFFF4081)]
        : const [Color(0xFF5B3FD6), Color(0xFF00A8C6), Color(0xFFE73C7E)];

    return Semantics(
      label: 'KI denkt',
      child: SizedBox.square(
        dimension: 76,
        child: AnimatedBuilder(
          animation: _animation,
          builder: (context, child) => CustomPaint(
            painter: _ThinkingOrbPainter(
              progress: _animation.value,
              colors: colors,
            ),
          ),
        ),
      ),
    );
  }
}

class _ThinkingOrbPainter extends CustomPainter {
  const _ThinkingOrbPainter({required this.progress, required this.colors});

  final double progress;
  final List<Color> colors;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final phase = progress * math.pi * 2;
    final baseRadius = size.shortestSide * (0.38 + 0.025 * math.sin(phase * 2));
    final path = Path();

    for (var index = 0; index <= 72; index++) {
      final angle = index / 72 * math.pi * 2;
      final radius = baseRadius *
          (1 +
              0.07 * math.sin(angle * 3 + phase) +
              0.035 * math.sin(angle * 5 - phase * 1.4));
      final point = center + Offset(math.cos(angle), math.sin(angle)) * radius;
      if (index == 0) {
        path.moveTo(point.dx, point.dy);
      } else {
        path.lineTo(point.dx, point.dy);
      }
    }
    path.close();

    final paint = Paint()
      ..shader = SweepGradient(
        colors: [...colors, colors.first],
        transform: GradientRotation(phase),
      ).createShader(Offset.zero & size)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2.5);
    canvas.drawShadow(path, colors.first.withValues(alpha: 0.35), 10, true);
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _ThinkingOrbPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.colors != colors;
}
