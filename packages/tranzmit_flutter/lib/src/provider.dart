import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import 'client.dart';
import 'controller.dart';
import 'models.dart';
import 'paywall.dart';

class TranzmitProvider extends StatefulWidget {
  const TranzmitProvider({
    super.key,
    required this.config,
    required this.child,
    this.onError,
    this.client,
  });

  final TranzmitConfig config;
  final Widget child;
  final void Function(TranzmitError error)? onError;
  final TranzmitClient? client;

  @override
  State<TranzmitProvider> createState() => _TranzmitProviderState();
}

class _TranzmitProviderState extends State<TranzmitProvider>
    with WidgetsBindingObserver {
  TranzmitController? _controller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _setupController();
  }

  @override
  void didUpdateWidget(covariant TranzmitProvider oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_configKey(widget.config) != _configKey(oldWidget.config)) {
      unawaited(_controller?.init(widget.config));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.detached) {
      _controller?.handleBackground();
    }
    if (state == AppLifecycleState.resumed) {
      _controller?.handleForeground();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller?.dispose();
    super.dispose();
  }

  void _setupController() {
    final client = widget.client ??
        TranzmitClient(
          storage: SharedPreferencesTranzmitStorage(),
          metadata: PlatformMetadata(
            platform: 'flutter',
            os: defaultTargetPlatform.name,
            sdkVersion: '0.1.0',
          ),
          onError: widget.onError,
        );

    final controller = TranzmitController(client);
    _controller = controller;

    unawaited(
      controller.init(widget.config).catchError((Object error) {
        if (error is TranzmitError) widget.onError?.call(error);
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) {
      return widget.child;
    }

    return Tranzmit(
      controller: controller,
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Stack(
          fit: StackFit.expand,
          children: [
            widget.child,
            TranzmitPaywallHost(controller: controller),
          ],
        ),
      ),
    );
  }
}

class Tranzmit extends InheritedNotifier<TranzmitController> {
  const Tranzmit({
    super.key,
    required TranzmitController controller,
    required super.child,
  }) : super(notifier: controller);

  static TranzmitController of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<Tranzmit>();
    assert(scope != null, 'TranzmitProvider was not found in the widget tree.');
    return scope!.notifier!;
  }

  static TranzmitController? maybeOf(BuildContext context) {
    return context.dependOnInheritedWidgetOfExactType<Tranzmit>()?.notifier;
  }
}

String _configKey(TranzmitConfig config) {
  return [
    config.publicKey,
    config.userId,
    config.resolvedApiBaseUrl,
    config.identifiers,
    config.userTraits,
    config.privateTraits,
  ].join('|');
}
