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

  @override
  void initState() {
    super.initState();
    _controller = _buildController(widget.spec);
  }

  @override
  void didUpdateWidget(covariant SpecRenderer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.spec.cacheKey != widget.spec.cacheKey ||
        oldWidget.spec.revision != widget.spec.revision ||
        oldWidget.spec.document?.html != widget.spec.document?.html) {
      _controller.loadHtmlString(
        _composeDocument(widget.spec),
        baseUrl: widget.spec.document?.baseUrl,
      );
    }
  }

  WebViewController _buildController(PaywallSpec spec) {
    final controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.transparent)
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            final uri = Uri.tryParse(request.url);
            if (uri == null) return NavigationDecision.prevent;
            if (uri.scheme == 'about' || uri.scheme == 'data') return NavigationDecision.navigate;
            _handleBridgeMessage(jsonEncode({'type': 'open_url', 'url': request.url}));
            return NavigationDecision.prevent;
          },
        ),
      )
      ..addJavaScriptChannel(
        'TranzmitBridge',
        onMessageReceived: (message) => _handleBridgeMessage(message.message),
      );

    controller.loadHtmlString(_composeDocument(spec), baseUrl: spec.document?.baseUrl);
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
      return const {'cta', 'dismiss', 'custom_action', 'open_url', 'ready'}.contains(type);
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

    final radius = widget.presentation == PresentationMode.inline ||
            widget.presentation == PresentationMode.fullscreen
        ? 0.0
        : 28.0;
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: SizedBox(
        width: double.infinity,
        height: _heightFor(context),
        child: WebViewWidget(controller: _controller),
      ),
    );
  }

  double _heightFor(BuildContext context) {
    final height = MediaQuery.maybeOf(context)?.size.height ?? 700;
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

String _composeDocument(PaywallSpec spec) {
  final document = spec.document;
  final html = document?.html;
  if (document == null || html == null || html.isEmpty) {
    return '''<!doctype html><html><body></body></html>''';
  }

  const bootstrap = '''
<script>
(function(){
  function post(message){
    try { window.TranzmitBridge.postMessage(JSON.stringify(message)); } catch (_) {}
  }
  window.Tranzmit = {
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

  return '''<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<style>
  html, body { margin: 0; padding: 0; width: 100%; min-height: 100%; background: transparent; -webkit-font-smoothing: antialiased; overflow-x: hidden; }
  body { min-height: 100svh; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  button, a { touch-action: manipulation; }
  img, svg, video, canvas { max-width: 100%; height: auto; }
${document.css ?? ''}
  html, body { max-width: 100vw; overflow-x: hidden !important; }
  body { overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .tz-paywall, .tranzmit-paywall {
    max-width: 100vw;
    overflow-x: hidden !important;
    overflow-y: auto !important;
  }
  h1, h2, h3, p, strong, span, button, a { overflow-wrap: anywhere; }
  @supports (min-height: 100dvh) { body { min-height: 100dvh; } }
</style>
</head>
<body>
$html
${document.js == null ? '' : '<script>${document.js}</script>'}
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
                  Text('cacheKey: $cacheKey', style: const TextStyle(fontSize: 12)),
                ],
                if (documentUrl != null) ...[
                  const SizedBox(height: 4),
                  Text('url: $documentUrl', style: const TextStyle(fontSize: 12)),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
