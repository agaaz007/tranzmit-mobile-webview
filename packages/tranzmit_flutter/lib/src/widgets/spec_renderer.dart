import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../controller.dart';
import '../models.dart';

class SpecRenderer extends StatefulWidget {
  const SpecRenderer({
    super.key,
    required this.spec,
    required this.onCTA,
    required this.onDismiss,
    this.presentation = PresentationMode.sheet,
  });

  final PaywallSpec spec;
  final PresentationMode presentation;
  final void Function(ProductSpec product) onCTA;
  final VoidCallback onDismiss;

  @override
  State<SpecRenderer> createState() => _SpecRendererState();
}

class _SpecRendererState extends State<SpecRenderer> {
  late final WebViewController _controller;
  String? _lastLoadedSignature;

  @override
  void initState() {
    super.initState();
    _controller = _buildController();
  }

  @override
  void didUpdateWidget(covariant SpecRenderer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.presentation != widget.presentation ||
        oldWidget.spec.cacheKey != widget.spec.cacheKey ||
        oldWidget.spec.revision != widget.spec.revision ||
        oldWidget.spec.document?.html != widget.spec.document?.html ||
        oldWidget.spec.document?.css != widget.spec.document?.css ||
        oldWidget.spec.document?.js != widget.spec.document?.js) {
      _lastLoadedSignature = null;
    }
  }

  WebViewController _buildController() {
    final controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.transparent)
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            final uri = Uri.tryParse(request.url);
            if (uri == null) return NavigationDecision.prevent;
            if (uri.scheme == 'about' || uri.scheme == 'data') {
              return NavigationDecision.navigate;
            }
            _handleBridgeMessage(
                jsonEncode({'type': 'open_url', 'url': request.url}));
            return NavigationDecision.prevent;
          },
        ),
      )
      ..addJavaScriptChannel(
        'TranzmitBridge',
        onMessageReceived: (message) => _handleBridgeMessage(message.message),
      );
    return controller;
  }

  void _handleBridgeMessage(String raw) {
    final message = parseWebViewBridgeMessage(raw);
    if (message == null) return;
    final type = bridgeMessageType(message);
    if (!_isAllowed(type)) return;

    switch (type) {
      case 'cta':
      case 'cta_click':
        final product = productForWebViewBridgeMessage(widget.spec, message) ??
            _defaultProduct(widget.spec);
        if (product != null) widget.onCTA(product);
        return;
      case 'dismiss':
        widget.onDismiss();
        return;
      case 'custom_action':
      case 'open_url':
      case 'ready':
        return;
    }
  }

  bool _isAllowed(String? type) {
    if (type == null) return false;
    if (type == 'cta_click') return true;
    final allowed = widget.spec.bridge?.allowedActions;
    if (allowed == null || allowed.isEmpty) {
      return const {'cta', 'dismiss', 'custom_action', 'open_url', 'ready'}
          .contains(type);
    }
    return allowed.contains(type) || type == 'ready';
  }

  @override
  Widget build(BuildContext context) {
    final html = widget.spec.document?.html;
    if (html == null || html.isEmpty) {
      return _MissingDocumentView(
        cacheKey: widget.spec.cacheKey,
        documentUrl: widget.spec.document?.url,
        height: _heightFor(context),
        presentation: widget.presentation,
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final viewport = PaywallViewport.fromContext(
          context,
          constraints,
          widget.presentation,
        );
        _scheduleDocumentLoad(viewport);
        final radius = widget.presentation == PresentationMode.inline ||
                widget.presentation == PresentationMode.fullscreen
            ? 0.0
            : 28.0;
        return ClipRRect(
          borderRadius: BorderRadius.circular(radius),
          child: SizedBox(
            width: viewport.width,
            height: viewport.height,
            child: WebViewWidget(controller: _controller),
          ),
        );
      },
    );
  }

  void _scheduleDocumentLoad(PaywallViewport viewport) {
    final signature =
        _documentSignature(widget.spec, widget.presentation, viewport);
    if (_lastLoadedSignature == signature) return;
    _lastLoadedSignature = signature;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _lastLoadedSignature != signature) return;
      _controller.loadHtmlString(
        _composeDocument(widget.spec, widget.presentation, viewport: viewport),
        baseUrl: widget.spec.document?.baseUrl,
      );
    });
  }

  String _documentSignature(
    PaywallSpec spec,
    PresentationMode presentation,
    PaywallViewport viewport,
  ) {
    return [
      presentation.name,
      spec.cacheKey,
      spec.revision,
      spec.document?.baseUrl,
      spec.document?.html,
      spec.document?.css,
      spec.document?.js,
      viewport.signature,
    ].join('|');
  }

  double _heightFor(BuildContext context, [double? availableHeight]) {
    final mediaHeight = MediaQuery.maybeOf(context)?.size.height ?? 700;
    final height = availableHeight != null && availableHeight.isFinite
        ? availableHeight
        : mediaHeight;
    switch (widget.presentation) {
      case PresentationMode.inline:
        return height * 0.72;
      case PresentationMode.modal:
        return height * 0.90;
      case PresentationMode.fullscreen:
        return height;
      case PresentationMode.sheet:
        return height * 0.86;
    }
  }
}

@visibleForTesting
class PaywallViewport {
  const PaywallViewport({
    required this.width,
    required this.height,
    required this.safeTop,
    required this.safeBottom,
    required this.safeLeft,
    required this.safeRight,
    required this.pixelRatio,
    required this.presentation,
  });

  final double width;
  final double height;
  final double safeTop;
  final double safeBottom;
  final double safeLeft;
  final double safeRight;
  final double pixelRatio;
  final PresentationMode presentation;

  factory PaywallViewport.fromContext(
    BuildContext context,
    BoxConstraints constraints,
    PresentationMode presentation,
  ) {
    final media = MediaQuery.maybeOf(context);
    final size = media?.size ?? const Size(390, 844);
    final padding = media?.padding ?? EdgeInsets.zero;
    final pixelRatio = media?.devicePixelRatio ?? 1;
    final constrainedWidth =
        constraints.maxWidth.isFinite && constraints.maxWidth > 0
            ? constraints.maxWidth
            : size.width;
    final constrainedHeight =
        constraints.maxHeight.isFinite && constraints.maxHeight > 0
            ? constraints.maxHeight
            : _fallbackHeight(size.height, presentation);

    return PaywallViewport(
      width: constrainedWidth,
      height: constrainedHeight,
      safeTop: padding.top,
      safeBottom: padding.bottom,
      safeLeft: padding.left,
      safeRight: padding.right,
      pixelRatio: pixelRatio,
      presentation: presentation,
    );
  }

  factory PaywallViewport.fallback(PresentationMode presentation) {
    return PaywallViewport(
      width: 390,
      height: _fallbackHeight(844, presentation),
      safeTop: 0,
      safeBottom: 0,
      safeLeft: 0,
      safeRight: 0,
      pixelRatio: 3,
      presentation: presentation,
    );
  }

  String get signature => [
        width.toStringAsFixed(1),
        height.toStringAsFixed(1),
        safeTop.toStringAsFixed(1),
        safeBottom.toStringAsFixed(1),
        safeLeft.toStringAsFixed(1),
        safeRight.toStringAsFixed(1),
        pixelRatio.toStringAsFixed(2),
        presentation.name,
      ].join(':');

  String get cssVariables => '''
  --tz-container-width: ${width.toStringAsFixed(2)}px;
  --tz-container-height: ${height.toStringAsFixed(2)}px;
  --tz-vw: ${width.toStringAsFixed(2)}px;
  --tz-vh: ${height.toStringAsFixed(2)}px;
  --tz-safe-top: ${safeTop.toStringAsFixed(2)}px;
  --tz-safe-bottom: ${safeBottom.toStringAsFixed(2)}px;
  --tz-safe-left: ${safeLeft.toStringAsFixed(2)}px;
  --tz-safe-right: ${safeRight.toStringAsFixed(2)}px;
  --tz-device-pixel-ratio: ${pixelRatio.toStringAsFixed(3)};
  --tz-scale: ${scale.toStringAsFixed(4)};
  --tz-cta-reserved-height: clamp(86px, 10.5vh, 108px);
''';

  double get scale {
    final widthScale = width / 390;
    final heightScale = height / 844;
    final raw = widthScale < heightScale ? widthScale : heightScale;
    if (raw < 0.82) return 0.82;
    if (raw > 1.12) return 1.12;
    return raw;
  }

  Map<String, Object> toJson() => {
        'width': width,
        'height': height,
        'safeTop': safeTop,
        'safeBottom': safeBottom,
        'safeLeft': safeLeft,
        'safeRight': safeRight,
        'pixelRatio': pixelRatio,
        'scale': scale,
        'presentation': presentation.name,
      };
}

double _fallbackHeight(double mediaHeight, PresentationMode presentation) {
  switch (presentation) {
    case PresentationMode.inline:
      return mediaHeight * 0.72;
    case PresentationMode.modal:
      return mediaHeight * 0.90;
    case PresentationMode.fullscreen:
      return mediaHeight;
    case PresentationMode.sheet:
      return mediaHeight * 0.86;
  }
}

ProductSpec? _defaultProduct(PaywallSpec spec) {
  if (spec.products.isEmpty) return null;
  return spec.products.firstWhere(
    (product) => product.isDefault == true || product.highlighted == true,
    orElse: () => spec.products.first,
  );
}

Map<String, dynamic>? parseWebViewBridgeMessage(String raw) {
  Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } catch (_) {
    return null;
  }
  if (decoded is! Map) return null;
  return Map<String, dynamic>.from(decoded);
}

String? bridgeMessageType(Map<String, dynamic> message) {
  return message['type']?.toString() ?? message['action']?.toString();
}

ProductSpec? productForWebViewBridgeMessage(
  PaywallSpec spec,
  Map<String, dynamic> message,
) {
  final productId =
      message['productId']?.toString() ?? message['product_id']?.toString();
  if (productId == null) return null;
  for (final product in spec.products) {
    if (product.id == productId) return product;
  }
  return null;
}

@visibleForTesting
String composePaywallDocumentForTest(
  PaywallSpec spec, {
  PresentationMode presentation = PresentationMode.sheet,
  PaywallViewport? viewport,
}) {
  return _composeDocument(spec, presentation, viewport: viewport);
}

String _composeDocument(
  PaywallSpec spec,
  PresentationMode presentation, {
  PaywallViewport? viewport,
}) {
  final document = spec.document;
  final html = document?.html;
  if (document == null || html == null || html.isEmpty) {
    return '''<!doctype html><html><body></body></html>''';
  }

  const bootstrap = '''
<script>
(function(){
  var viewport = window.TranzmitNativeViewport || null;
  function post(message){
    try { window.TranzmitBridge.postMessage(JSON.stringify(message)); } catch (_) {}
  }
  window.Tranzmit = {
    viewport: viewport,
    post: post,
    cta: function(productId){ post({ type: 'cta', productId: productId }); },
    dismiss: function(){ post({ type: 'dismiss' }); },
    customAction: function(name, payload){ post({ type: 'custom_action', name: name, payload: payload || {} }); }
  };
  document.addEventListener('click', function(event){
    var node = event.target;
    while (node && node !== document) {
      var action = node.getAttribute && node.getAttribute('data-tranzmit-action');
      if (action) {
        event.preventDefault();
        post({
          type: action === 'cta' ? 'cta' : action,
          productId: node.getAttribute('data-product-id') || undefined,
          name: node.getAttribute('data-action-name') || undefined,
          url: node.getAttribute('href') || undefined
        });
        return;
      }
      node = node.parentNode;
    }
  }, true);
  window.addEventListener('load', function(){ post({ type: 'ready' }); });
})();
</script>
''';

  final presentationClass = 'tz-presentation-${presentation.name}';
  final resolvedViewport = viewport ?? PaywallViewport.fallback(presentation);
  final viewportJson = jsonEncode(resolvedViewport.toJson());

  return '''<!doctype html>
<html class="$presentationClass" data-tranzmit-presentation="${presentation.name}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<style>
  :root {
${resolvedViewport.cssVariables}
  }
  html, body { margin: 0; padding: 0; width: var(--tz-vw); min-height: var(--tz-vh); background: transparent; -webkit-font-smoothing: antialiased; overflow-x: hidden; }
  body { min-height: var(--tz-vh); }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  button, a { touch-action: manipulation; }
  img, svg, video, canvas { max-width: 100%; height: auto; }
${document.css ?? ''}
  html, body { max-width: var(--tz-vw); overflow-x: hidden !important; }
  body { overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .tz-paywall:not(.phone), .tranzmit-paywall {
    max-width: var(--tz-vw);
    overflow-x: hidden !important;
    overflow-y: auto !important;
  }
  .$presentationClass .tz-paywall:not(.phone),
  .$presentationClass .tranzmit-paywall {
    min-height: 100%;
  }
  .tz-presentation-fullscreen,
  .tz-presentation-fullscreen body {
    width: var(--tz-vw);
    height: var(--tz-vh);
    min-height: var(--tz-vh);
    overflow: hidden;
  }
  .tz-presentation-fullscreen .tz-paywall:not(.phone),
  .tz-presentation-fullscreen .tranzmit-paywall {
    width: var(--tz-vw) !important;
    height: var(--tz-vh) !important;
    min-height: var(--tz-vh) !important;
    max-height: var(--tz-vh) !important;
    margin: 0 !important;
    padding-bottom: calc(var(--tz-safe-bottom) + var(--tz-cta-reserved-height)) !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    overflow-y: auto !important;
  }
  .tz-presentation-fullscreen .tz-paywall:not(.phone) .cta,
  .tz-presentation-fullscreen .tranzmit-paywall .cta {
    left: calc(var(--tz-safe-left) + clamp(14px, 4vw, 22px)) !important;
    right: calc(var(--tz-safe-right) + clamp(14px, 4vw, 22px)) !important;
    bottom: calc(var(--tz-safe-bottom) + clamp(10px, 3vw, 18px)) !important;
  }
  .tz-presentation-fullscreen .tz-paywall:not(.phone) .tz-close,
  .tz-presentation-fullscreen .tranzmit-paywall .tz-close,
  .tz-presentation-fullscreen .tz-paywall:not(.phone) .close,
  .tz-presentation-fullscreen .tranzmit-paywall .close {
    display: none !important;
  }
  @media (max-height: 880px) {
    .tz-presentation-fullscreen .influish_intro_offer {
      gap: clamp(4px, 0.75vh, 8px) !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer .intro-brand {
      margin-top: 0 !important;
      margin-bottom: 2px !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer h1 {
      font-size: clamp(30px, 8.6vw, 39px) !important;
      line-height: 0.98 !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer .subtitle {
      font-size: clamp(13px, 3.6vw, 15px) !important;
      line-height: 1.25 !important;
      margin-top: 2px !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer .intro-offer {
      margin-top: 6px !important;
      padding: 18px 14px 10px !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer .intro-price strong {
      font-size: clamp(28px, 7.8vw, 36px) !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer .feature-panel {
      padding: 10px 12px !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer .feature-panel li {
      padding-top: 6px !important;
      padding-bottom: 6px !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer .intro-testimonial {
      display: flex !important;
      gap: 9px !important;
      padding: 9px 10px !important;
      border-radius: 16px !important;
      font-size: 12px !important;
      line-height: 1.18 !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer .intro-testimonial .avatar {
      width: 42px !important;
      height: 42px !important;
      flex: 0 0 42px !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer .intro-testimonial p {
      margin: 1px 0 0 !important;
      letter-spacing: 1px !important;
      line-height: 1 !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer .intro-testimonial em {
      display: none !important;
    }
    .tz-presentation-fullscreen .influish_intro_offer .legal-row {
      margin-top: auto !important;
    }
  }
  .tz-presentation-sheet .tz-paywall:not(.phone),
  .tz-presentation-sheet .tranzmit-paywall,
  .tz-presentation-modal .tz-paywall:not(.phone),
  .tz-presentation-modal .tranzmit-paywall {
    border-radius: clamp(20px, 7vw, 28px);
  }
  .tz-paywall:not(.phone) h1,
  .tz-paywall:not(.phone) h2,
  .tz-paywall:not(.phone) h3,
  .tz-paywall:not(.phone) p,
  .tz-paywall:not(.phone) strong,
  .tz-paywall:not(.phone) span,
  .tz-paywall:not(.phone) button,
  .tz-paywall:not(.phone) a,
  .tranzmit-paywall h1,
  .tranzmit-paywall h2,
  .tranzmit-paywall h3,
  .tranzmit-paywall p,
  .tranzmit-paywall strong,
  .tranzmit-paywall span,
  .tranzmit-paywall button,
  .tranzmit-paywall a { overflow-wrap: anywhere; }
</style>
</head>
<body class="$presentationClass">
$html
${document.js == null ? '' : '<script>${document.js}</script>'}
<script>window.TranzmitNativeViewport = $viewportJson;</script>
$bootstrap
</body>
</html>''';
}

class _MissingDocumentView extends StatelessWidget {
  const _MissingDocumentView({
    required this.cacheKey,
    required this.documentUrl,
    required this.height,
    required this.presentation,
  });

  final String? cacheKey;
  final String? documentUrl;
  final double height;
  final PresentationMode presentation;

  @override
  Widget build(BuildContext context) {
    final radius = presentation == PresentationMode.inline ||
            presentation == PresentationMode.fullscreen
        ? 0.0
        : 28.0;
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: SizedBox(
        width: double.infinity,
        height: height,
        child: ColoredBox(
          color: const Color(0xFFFFF7ED),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Paywall document not loaded',
                  style: TextStyle(
                    color: Color(0xFF9A3412),
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  'This SDK does not render local fallback paywalls. Wait for init/refresh to hydrate the hosted document from your Tranzmit server.',
                  style: TextStyle(color: Color(0xFF7C2D12), height: 1.4),
                ),
                if (cacheKey != null) ...[
                  const SizedBox(height: 12),
                  Text('cacheKey: $cacheKey',
                      style: const TextStyle(fontSize: 12)),
                ],
                if (documentUrl != null) ...[
                  const SizedBox(height: 4),
                  Text('url: $documentUrl',
                      style: const TextStyle(fontSize: 12)),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
