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
    final radius = widget.presentation == PresentationMode.inline ? 0.0 : 28.0;
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
        return height * 0.86;
      case PresentationMode.sheet:
        return height * 0.82;
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
  final document = spec.document ?? _legacyDocument(spec);
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
  html, body { margin: 0; padding: 0; background: transparent; -webkit-font-smoothing: antialiased; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  button, a { touch-action: manipulation; }
${document.css ?? ''}
</style>
</head>
<body>
${document.html ?? ''}
${document.js == null ? '' : '<script>${document.js}</script>'}
$bootstrap
</body>
</html>''';
}

WebViewDocumentSpec _legacyDocument(PaywallSpec spec) {
  final product = _defaultProduct(spec);
  final title = spec.header?.title ?? spec.headline ?? 'Upgrade';
  final subtitle = spec.header?.subtitle ?? spec.subheadline;
  final featureItems = (spec.features ?? const [])
      .map((feature) => '<li>${_escapeHtml(_featureText(feature))}</li>')
      .join();
  final price = product == null ? '' : _priceText(product);
  final productHtml = product == null
      ? ''
      : '''
<div class="product">
  ${product.badge == null ? '' : '<span class="badge">${_escapeHtml(product.badge!)}</span>'}
  <strong>${_escapeHtml(product.name)}</strong>
  ${price.isEmpty ? '' : '<span>${_escapeHtml(price)}</span>'}
</div>''';

  return WebViewDocumentSpec(
    html: '''
<main class="tranzmit-paywall">
  <section class="card">
    <h1>${_escapeHtml(title)}</h1>
    ${subtitle == null ? '' : '<p class="subtitle">${_escapeHtml(subtitle)}</p>'}
    ${featureItems.isEmpty ? '' : '<ul>$featureItems</ul>'}
    $productHtml
    <button data-tranzmit-action="cta" data-product-id="${_escapeHtml(product?.id ?? 'product')}">${_escapeHtml(spec.cta.text)}</button>
    ${spec.secondaryCta == null ? '' : '<button class="secondary" data-tranzmit-action="dismiss">${_escapeHtml(spec.secondaryCta!)}</button>'}
  </section>
</main>''',
    css: '''
body { min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: rgba(15, 23, 42, 0.48); color: #111827; }
.tranzmit-paywall { width: 100%; padding: 24px; }
.card { background: #fff; border-radius: 28px; box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28); padding: 28px; text-align: center; }
h1 { margin: 0; font-size: 32px; line-height: 1.05; letter-spacing: -0.04em; }
.subtitle { color: #6b7280; font-size: 16px; line-height: 1.45; }
ul { padding: 0; list-style: none; display: grid; gap: 10px; margin: 20px 0; text-align: left; }
li { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 14px; padding: 12px; }
.product { display: grid; gap: 6px; border: 1px solid #dbeafe; background: #eff6ff; border-radius: 18px; padding: 16px; margin: 18px 0; }
.badge { justify-self: center; background: #1d4ed8; color: white; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; }
button { width: 100%; border: 0; border-radius: 999px; background: #1d4ed8; color: white; padding: 16px; font-size: 16px; font-weight: 800; }
.secondary { margin-top: 10px; background: transparent; color: #64748b; }
''',
  );
}

String _featureText(Object? feature) {
  if (feature is Map) {
    final text = feature['text'] ?? feature['title'] ?? feature['label'];
    if (text != null) return text.toString();
  }
  return feature.toString().split('|').first;
}

String _priceText(ProductSpec product) {
  final price = product.price;
  if (price is String) return price;
  if (price is ProductPrice) {
    final dollars = (price.amount / 100).toStringAsFixed(2);
    final interval = price.interval == null ? '' : ' / ${price.interval}';
    return '${price.currency} $dollars$interval';
  }
  return price.toString();
}

String _escapeHtml(String value) {
  return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
}
