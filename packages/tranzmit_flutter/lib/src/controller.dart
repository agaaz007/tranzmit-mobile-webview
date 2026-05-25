import 'dart:async';

import 'package:flutter/foundation.dart';

import 'client.dart';
import 'models.dart';

enum PresentationMode { modal, sheet, fullscreen, inline }

class GateOptions {
  const GateOptions({
    this.presentation,
    this.onCTA,
    this.onDismiss,
    this.onImpression,
  });

  final PresentationMode? presentation;
  final void Function(ProductSpec product)? onCTA;
  final VoidCallback? onDismiss;
  final VoidCallback? onImpression;
}

class GateResult {
  const GateResult({
    required this.shown,
    this.variantId,
    required this.dismiss,
  });

  final bool shown;
  final String? variantId;
  final VoidCallback dismiss;
}

class ActivePaywall {
  ActivePaywall({
    required this.id,
    required this.trigger,
    required this.placement,
    required this.presentation,
    required this.options,
    required this.shownAt,
  });

  final String id;
  final String trigger;
  final PlacementConfig placement;
  final PresentationMode presentation;
  final GateOptions options;
  final DateTime shownAt;
}

class TranzmitController extends ChangeNotifier {
  TranzmitController(this._client);

  final TranzmitClient _client;
  final Map<String, ActivePaywall> _activePaywalls = <String, ActivePaywall>{};

  bool _isReady = false;
  bool _disposed = false;

  bool get isReady => _isReady;
  bool get ready => _isReady;
  List<ActivePaywall> get activePaywalls =>
      List<ActivePaywall>.unmodifiable(_activePaywalls.values);

  Future<void> init(TranzmitConfig config) async {
    _setReady(false);
    _activePaywalls.clear();
    _notifyIfAlive();

    await _client.init(config);
    _setReady(_client.isReady);
  }

  Future<void> refreshConfig() async {
    _setReady(false);
    _activePaywalls.clear();
    _notifyIfAlive();

    await _client.refreshConfig();
    _setReady(_client.isReady);
  }

  PlacementConfig? getPlacement(String trigger) => _client.getPlacement(trigger);

  GateResult gate(String trigger, [GateOptions options = const GateOptions()]) {
    if (!_client.isReady) return _noopResult;

    final placement = _client.getPlacement(trigger);
    if (placement == null) return _noopResult;

    final existing = _activePaywalls[trigger];
    if (existing != null) {
      return GateResult(
        shown: true,
        variantId: existing.placement.variantId,
        dismiss: () => dismissPaywall(existing.id),
      );
    }

    final active = ActivePaywall(
      id: trigger,
      trigger: trigger,
      placement: placement,
      presentation: options.presentation ?? _presentationFromSpec(placement.spec),
      options: options,
      shownAt: DateTime.now(),
    );

    _activePaywalls[trigger] = active;
    _client.track('impression', attribution(trigger, placement));
    options.onImpression?.call();
    _notifyIfAlive();

    return GateResult(
      shown: true,
      variantId: placement.variantId,
      dismiss: () => dismissPaywall(active.id),
    );
  }

  GateResult presentPlacement(
    String trigger, {
    PresentationMode? presentation,
    void Function(ProductSpec product)? onCTA,
    VoidCallback? onDismiss,
    VoidCallback? onImpression,
  }) {
    return gate(
      trigger,
      GateOptions(
        presentation: presentation,
        onCTA: onCTA,
        onDismiss: onDismiss,
        onImpression: onImpression,
      ),
    );
  }

  void track(String event, [Map<String, Object?>? properties]) {
    _client.track(event, properties);
  }

  void reportConversion(Map<String, Object?> data) {
    _client.reportConversion(data);
  }

  Future<void> flush() => _client.flush();

  void handleCTA(ActivePaywall active, ProductSpec product) {
    _client.track('cta_click', {
      ...attribution(active.trigger, active.placement),
      'productId': product.id,
    });
    _activePaywalls.remove(active.id);
    active.options.onCTA?.call(product);
    _notifyIfAlive();
  }

  void dismissPaywall(String id, {bool trackDismissal = true}) {
    final active = _activePaywalls.remove(id);
    if (active == null) return;

    if (trackDismissal) {
      _client.track('dismissal', {
        ...attribution(active.trigger, active.placement),
        'time_on_screen_ms':
            DateTime.now().difference(active.shownAt).inMilliseconds,
      });
      active.options.onDismiss?.call();
    }
    _notifyIfAlive();
  }

  void handleBackground() => _client.handleBackground();

  void handleForeground() => _client.handleForeground();

  void _setReady(bool ready) {
    if (_isReady == ready) return;
    _isReady = ready;
    _notifyIfAlive();
  }

  void _notifyIfAlive() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
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

const _noopResult = GateResult(shown: false, dismiss: _noopDismiss);

void _noopDismiss() {}
