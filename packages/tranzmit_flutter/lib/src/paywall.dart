import 'package:flutter/material.dart';

import 'controller.dart';
import 'models.dart';
import 'provider.dart';
import 'widgets/spec_renderer.dart';

class TranzmitPaywallHost extends StatelessWidget {
  const TranzmitPaywallHost({super.key, required this.controller});

  final TranzmitController controller;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final activePaywalls = controller.activePaywalls;
        if (activePaywalls.isEmpty) return const SizedBox.shrink();

        return Stack(
          children: [
            for (final active in activePaywalls)
              _PresentedPaywall(
                active: active,
                onCTA: (product) => controller.handleCTA(active, product),
                onDismiss: () => controller.dismissPaywall(active.id),
              ),
          ],
        );
      },
    );
  }
}

class TranzmitPaywall extends StatefulWidget {
  const TranzmitPaywall({
    super.key,
    required this.visible,
    this.trigger,
    this.spec,
    this.variantId,
    this.presentation,
    this.onCTA,
    this.onDismiss,
    this.onImpression,
  });

  final String? trigger;
  final PaywallSpec? spec;
  final String? variantId;
  final bool visible;
  final PresentationMode? presentation;
  final void Function(ProductSpec product)? onCTA;
  final VoidCallback? onDismiss;
  final VoidCallback? onImpression;

  @override
  State<TranzmitPaywall> createState() => _TranzmitPaywallState();
}

class _TranzmitPaywallState extends State<TranzmitPaywall> {
  String? _lastImpressionKey;
  DateTime _shownAt = DateTime.now();

  @override
  Widget build(BuildContext context) {
    if (!widget.visible) return const SizedBox.shrink();

    final controller = Tranzmit.maybeOf(context);
    final placement = widget.trigger == null
        ? null
        : controller?.getPlacement(widget.trigger!);
    final spec = widget.spec ?? placement?.spec;
    if (spec == null) return const SizedBox.shrink();

    final trigger = widget.trigger ?? 'dynamic_spec';
    final variantId =
        widget.spec == null ? placement?.variantId : widget.variantId;
    final impressionKey =
        '$trigger:${variantId ?? 'none'}:${spec.cacheKey ?? spec.revision ?? 'none'}';

    if (_lastImpressionKey != impressionKey) {
      _lastImpressionKey = impressionKey;
      _shownAt = DateTime.now();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        controller?.track('impression', {
          'trigger': trigger,
          if (variantId != null) 'variantId': variantId,
        });
        widget.onImpression?.call();
      });
    }

    return _PresentedSpec(
      spec: spec,
      presentation: widget.presentation ?? _presentationFromSpec(spec),
      onCTA: (product) {
        controller?.track('cta_click', {
          'trigger': trigger,
          if (variantId != null) 'variantId': variantId,
          'productId': product.id,
        });
        widget.onCTA?.call(product);
      },
      onDismiss: () {
        controller?.track('dismissal', {
          'trigger': trigger,
          if (variantId != null) 'variantId': variantId,
          'time_on_screen_ms':
              DateTime.now().difference(_shownAt).inMilliseconds,
        });
        widget.onDismiss?.call();
      },
    );
  }
}

class _PresentedPaywall extends StatelessWidget {
  const _PresentedPaywall({
    required this.active,
    required this.onCTA,
    required this.onDismiss,
  });

  final ActivePaywall active;
  final void Function(ProductSpec product) onCTA;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return _PresentedSpec(
      spec: active.placement.spec,
      presentation: active.presentation,
      onCTA: onCTA,
      onDismiss: onDismiss,
    );
  }
}

class _PresentedSpec extends StatelessWidget {
  const _PresentedSpec({
    required this.spec,
    required this.presentation,
    required this.onCTA,
    required this.onDismiss,
  });

  final PaywallSpec spec;
  final PresentationMode presentation;
  final void Function(ProductSpec product) onCTA;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    if (presentation == PresentationMode.inline) {
      return SpecRenderer(
        spec: spec,
        presentation: presentation,
        onCTA: onCTA,
        onDismiss: onDismiss,
      );
    }

    if (presentation == PresentationMode.fullscreen) {
      return Positioned.fill(
        child: Material(
          color: Colors.transparent,
          child: Stack(
            children: [
              Positioned.fill(
                child: SpecRenderer(
                  spec: spec,
                  presentation: presentation,
                  onCTA: onCTA,
                  onDismiss: onDismiss,
                ),
              ),
              SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child:
                      _FullscreenCloseButton(spec: spec, onDismiss: onDismiss),
                ),
              ),
            ],
          ),
        ),
      );
    }

    if (presentation == PresentationMode.modal) {
      return Positioned.fill(
        child: Container(
          color: Colors.black.withValues(alpha: 0.45),
          padding: const EdgeInsets.all(24),
          child: SafeArea(
            child: Center(
              child: FractionallySizedBox(
                heightFactor: 0.90,
                widthFactor: 1,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 440),
                  child: SpecRenderer(
                    spec: spec,
                    presentation: presentation,
                    onCTA: onCTA,
                    onDismiss: onDismiss,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    return Positioned.fill(
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onDismiss,
        child: Container(
          color: Colors.black.withValues(alpha: 0.35),
          alignment: Alignment.bottomCenter,
          child: GestureDetector(
            onTap: () {},
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: FractionallySizedBox(
                  heightFactor: 0.86,
                  widthFactor: 1,
                  child: SpecRenderer(
                    spec: spec,
                    presentation: presentation,
                    onCTA: onCTA,
                    onDismiss: onDismiss,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FullscreenCloseButton extends StatelessWidget {
  const _FullscreenCloseButton({required this.spec, required this.onDismiss});

  final PaywallSpec spec;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final alignRight = spec.templateId == 'influish_intro_offer';
    return Align(
      alignment: alignRight ? Alignment.topRight : Alignment.topLeft,
      child: Material(
        color: alignRight
            ? Colors.transparent
            : Colors.white.withValues(alpha: 0.92),
        shape: const CircleBorder(),
        elevation: alignRight ? 0 : 2,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onDismiss,
          child: const SizedBox(
            width: 48,
            height: 48,
            child: Icon(Icons.close, color: Color(0xFF6F6878), size: 24),
          ),
        ),
      ),
    );
  }
}

PresentationMode _presentationFromSpec(PaywallSpec spec) {
  switch (spec.presentationMode) {
    case 'modal':
      return PresentationMode.modal;
    case 'fullscreen':
      return PresentationMode.fullscreen;
    case 'inline':
      return PresentationMode.inline;
    case 'sheet':
    default:
      return PresentationMode.sheet;
  }
}
