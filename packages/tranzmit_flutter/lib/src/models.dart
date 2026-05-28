typedef JsonMap = Map<String, dynamic>;

const defaultApiBaseUrl = 'https://api-production-2146.up.railway.app';

class TranzmitConfig {
  const TranzmitConfig({
    required this.publicKey,
    this.userId,
    this.identifiers,
    this.userTraits,
    this.privateTraits,
    this.apiBaseUrl,
    this.debug = false,
  });

  final String publicKey;
  final String? userId;
  final Map<String, String>? identifiers;
  final Map<String, Object?>? userTraits;
  final Map<String, Object?>? privateTraits;
  final String? apiBaseUrl;
  final bool debug;

  String get resolvedApiBaseUrl {
    final explicit = apiBaseUrl?.trim();
    if (explicit == null || explicit.isEmpty) return defaultApiBaseUrl;
    return explicit.endsWith('/')
        ? explicit.substring(0, explicit.length - 1)
        : explicit;
  }
}

class TranzmitIdentity {
  const TranzmitIdentity({
    this.userId,
    required this.identifiers,
  });

  final String? userId;
  final Map<String, String> identifiers;

  JsonMap toJson() => {
        if (userId != null) 'userId': userId,
        'identifiers': identifiers,
      };

  factory TranzmitIdentity.fromJson(JsonMap json) {
    return TranzmitIdentity(
      userId: json['userId'] as String?,
      identifiers: _stringMap(json['identifiers']),
    );
  }
}

class ProductPrice {
  const ProductPrice({
    required this.amount,
    required this.currency,
    this.interval,
  });

  final int amount;
  final String currency;
  final String? interval;

  factory ProductPrice.fromJson(JsonMap json) {
    return ProductPrice(
      amount: (json['amount'] as num).round(),
      currency: json['currency'] as String,
      interval: json['interval'] as String?,
    );
  }

  JsonMap toJson() => {
        'amount': amount,
        'currency': currency,
        if (interval != null) 'interval': interval,
      };
}

class ProductSpec {
  const ProductSpec({
    required this.id,
    required this.name,
    required this.price,
    this.description,
    this.originalPrice,
    this.badge,
    this.features,
    this.isDefault,
    this.metadata,
    this.highlighted,
  });

  final String id;
  final String name;
  final Object price;
  final String? description;
  final String? originalPrice;
  final String? badge;
  final List<String>? features;
  final bool? isDefault;
  final Map<String, String>? metadata;
  final bool? highlighted;

  factory ProductSpec.fromJson(JsonMap json) {
    final rawPrice = json['price'];
    return ProductSpec(
      id: json['id'] as String,
      name: json['name'] as String,
      description: json['description'] as String?,
      price: rawPrice is String
          ? rawPrice
          : ProductPrice.fromJson(Map<String, dynamic>.from(rawPrice as Map)),
      originalPrice: json['originalPrice'] as String?,
      badge: json['badge'] as String?,
      features: _stringList(json['features']),
      isDefault: json['isDefault'] as bool?,
      metadata: json['metadata'] == null ? null : _stringMap(json['metadata']),
      highlighted: json['highlighted'] as bool?,
    );
  }

  JsonMap toJson() => {
        'id': id,
        'name': name,
        'price': price is ProductPrice
            ? (price as ProductPrice).toJson()
            : price as String,
        if (description != null) 'description': description,
        if (originalPrice != null) 'originalPrice': originalPrice,
        if (badge != null) 'badge': badge,
        if (features != null) 'features': features,
        if (isDefault != null) 'isDefault': isDefault,
        if (metadata != null) 'metadata': metadata,
        if (highlighted != null) 'highlighted': highlighted,
      };
}

class CtaSpec {
  const CtaSpec({required this.text, this.subtext});

  final String text;
  final String? subtext;

  factory CtaSpec.fromJson(Object? value) {
    if (value is String) return CtaSpec(text: value);
    final json = Map<String, dynamic>.from(value as Map);
    return CtaSpec(
      text: json['text'] as String,
      subtext: json['subtext'] as String?,
    );
  }

  Object toJson() =>
      subtext == null ? text : {'text': text, 'subtext': subtext};
}

class PaywallHeaderSpec {
  const PaywallHeaderSpec({
    required this.title,
    this.subtitle,
    this.imageUrl,
    this.icon,
    this.alignment,
  });

  final String title;
  final String? subtitle;
  final String? imageUrl;
  final String? icon;
  final String? alignment;

  factory PaywallHeaderSpec.fromJson(JsonMap json) {
    return PaywallHeaderSpec(
      title: json['title'] as String,
      subtitle: json['subtitle'] as String?,
      imageUrl: json['imageUrl'] as String?,
      icon: json['icon'] as String?,
      alignment: json['alignment'] as String?,
    );
  }

  JsonMap toJson() => {
        'title': title,
        if (subtitle != null) 'subtitle': subtitle,
        if (imageUrl != null) 'imageUrl': imageUrl,
        if (icon != null) 'icon': icon,
        if (alignment != null) 'alignment': alignment,
      };
}

class DismissSpec {
  const DismissSpec({required this.enabled, this.delayMs});

  final bool enabled;
  final int? delayMs;

  factory DismissSpec.fromJson(JsonMap json) {
    return DismissSpec(
      enabled: json['enabled'] as bool? ?? true,
      delayMs: (json['delay_ms'] ?? json['delayMs']) as int?,
    );
  }

  JsonMap toJson() => {
        'enabled': enabled,
        if (delayMs != null) 'delay_ms': delayMs,
      };
}

class AssetManifest {
  const AssetManifest({this.images, this.fonts});

  final Map<String, String>? images;
  final List<String>? fonts;

  factory AssetManifest.fromJson(JsonMap? json) {
    if (json == null) return const AssetManifest();
    return AssetManifest(
      images: json['images'] == null ? null : _stringMap(json['images']),
      fonts: _stringList(json['fonts']),
    );
  }

  JsonMap toJson() => {
        if (images != null) 'images': images,
        if (fonts != null) 'fonts': fonts,
      };
}

class WebViewDocumentSpec {
  const WebViewDocumentSpec({
    this.html,
    this.css,
    this.js,
    this.baseUrl,
    this.url,
    this.integrity,
    this.cacheTtlSeconds,
  });

  final String? html;
  final String? css;
  final String? js;
  final String? baseUrl;
  final String? url;
  final String? integrity;
  final int? cacheTtlSeconds;

  factory WebViewDocumentSpec.fromJson(JsonMap json) {
    return WebViewDocumentSpec(
      html: json['html'] as String?,
      css: json['css'] as String?,
      js: json['js'] as String?,
      baseUrl: json['baseUrl'] as String?,
      url: json['url'] as String?,
      integrity: json['integrity'] as String?,
      cacheTtlSeconds: (json['cacheTtlSeconds'] as num?)?.round(),
    );
  }

  JsonMap toJson() => {
        if (html != null) 'html': html,
        if (css != null) 'css': css,
        if (js != null) 'js': js,
        if (baseUrl != null) 'baseUrl': baseUrl,
        if (url != null) 'url': url,
        if (integrity != null) 'integrity': integrity,
        if (cacheTtlSeconds != null) 'cacheTtlSeconds': cacheTtlSeconds,
      };
}

class WebViewBridgeSpec {
  const WebViewBridgeSpec({
    required this.version,
    this.allowedActions,
  });

  final int version;
  final List<String>? allowedActions;

  factory WebViewBridgeSpec.fromJson(JsonMap json) {
    return WebViewBridgeSpec(
      version: (json['version'] as num?)?.round() ?? 1,
      allowedActions: _stringList(json['allowedActions']),
    );
  }

  JsonMap toJson() => {
        'version': version,
        if (allowedActions != null) 'allowedActions': allowedActions,
      };
}

class PaywallSpec {
  const PaywallSpec({
    required this.cta,
    required this.products,
    this.renderer = 'webview',
    this.document,
    this.templateId,
    this.revision,
    this.cacheKey,
    this.presentationMode,
    this.design,
    this.bridge,
    this.header,
    this.headline,
    this.subheadline,
    this.secondaryCta,
    this.theme,
    this.socialProof,
    this.features,
    this.socialProofConfig,
    this.urgency,
    this.legal,
    this.style,
    this.dismiss,
    this.assets,
    this.metadata,
  });

  final String renderer;
  final WebViewDocumentSpec? document;
  final String? templateId;
  final Object? revision;
  final String? cacheKey;
  final String? presentationMode;
  final JsonMap? design;
  final WebViewBridgeSpec? bridge;
  final PaywallHeaderSpec? header;
  final String? headline;
  final String? subheadline;
  final CtaSpec cta;
  final String? secondaryCta;
  final String? theme;
  final bool? socialProof;
  final List<Object?>? features;
  final JsonMap? socialProofConfig;
  final JsonMap? urgency;
  final String? legal;
  final JsonMap? style;
  final DismissSpec? dismiss;
  final List<ProductSpec> products;
  final AssetManifest? assets;
  final Map<String, String>? metadata;

  factory PaywallSpec.fromJson(JsonMap json) {
    return PaywallSpec(
      renderer: json['renderer'] as String? ?? 'webview',
      document: json['document'] == null
          ? null
          : WebViewDocumentSpec.fromJson(
              Map<String, dynamic>.from(json['document'] as Map),
            ),
      templateId: json['templateId'] as String?,
      revision: json['revision'],
      cacheKey: json['cacheKey'] as String?,
      presentationMode: _presentationMode(json['presentation']),
      design: json['design'] == null
          ? null
          : Map<String, dynamic>.from(json['design'] as Map),
      bridge: json['bridge'] == null
          ? null
          : WebViewBridgeSpec.fromJson(
              Map<String, dynamic>.from(json['bridge'] as Map),
            ),
      header: json['header'] == null
          ? null
          : PaywallHeaderSpec.fromJson(
              Map<String, dynamic>.from(json['header'] as Map),
            ),
      headline: json['headline'] as String?,
      subheadline: json['subheadline'] as String?,
      cta: CtaSpec.fromJson(json['cta']),
      secondaryCta: json['secondaryCta'] as String?,
      theme: json['theme'] as String?,
      socialProof: json['socialProof'] as bool?,
      features: (json['features'] as List?)?.cast<Object?>(),
      socialProofConfig: json['social_proof'] == null
          ? null
          : Map<String, dynamic>.from(json['social_proof'] as Map),
      urgency: json['urgency'] == null
          ? null
          : Map<String, dynamic>.from(json['urgency'] as Map),
      legal: json['legal'] as String?,
      style: json['style'] == null
          ? null
          : Map<String, dynamic>.from(json['style'] as Map),
      dismiss: json['dismiss'] == null
          ? null
          : DismissSpec.fromJson(
              Map<String, dynamic>.from(json['dismiss'] as Map),
            ),
      products: (json['products'] as List? ?? const [])
          .map((item) => ProductSpec.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
      assets: json['assets'] == null
          ? null
          : AssetManifest.fromJson(
              Map<String, dynamic>.from(json['assets'] as Map),
            ),
      metadata: json['metadata'] == null ? null : _stringMap(json['metadata']),
    );
  }

  JsonMap toJson() => {
        'renderer': renderer,
        if (document != null) 'document': document!.toJson(),
        if (templateId != null) 'templateId': templateId,
        if (revision != null) 'revision': revision,
        if (cacheKey != null) 'cacheKey': cacheKey,
        if (presentationMode != null)
          'presentation': {'mode': presentationMode},
        if (design != null) 'design': design,
        if (bridge != null) 'bridge': bridge!.toJson(),
        if (header != null) 'header': header!.toJson(),
        if (headline != null) 'headline': headline,
        if (subheadline != null) 'subheadline': subheadline,
        'cta': cta.toJson(),
        if (secondaryCta != null) 'secondaryCta': secondaryCta,
        if (theme != null) 'theme': theme,
        if (socialProof != null) 'socialProof': socialProof,
        if (features != null) 'features': features,
        if (socialProofConfig != null) 'social_proof': socialProofConfig,
        if (urgency != null) 'urgency': urgency,
        if (legal != null) 'legal': legal,
        if (style != null) 'style': style,
        if (dismiss != null) 'dismiss': dismiss!.toJson(),
        'products': products.map((product) => product.toJson()).toList(),
        if (assets != null) 'assets': assets!.toJson(),
        if (metadata != null) 'metadata': metadata,
      };
}

String? _presentationMode(Object? value) {
  if (value is Map) {
    final mode = value['mode']?.toString();
    if (mode == 'sheet' ||
        mode == 'modal' ||
        mode == 'fullscreen' ||
        mode == 'inline') {
      return mode;
    }
  }
  return null;
}

class PlacementConfig {
  const PlacementConfig({
    required this.trigger,
    required this.enabled,
    required this.variantId,
    required this.spec,
    this.placementId,
    this.variantKey,
  });

  final String trigger;
  final bool enabled;
  final String? placementId;
  final String variantId;
  final String? variantKey;
  final PaywallSpec spec;

  factory PlacementConfig.fromJson(JsonMap json) {
    return PlacementConfig(
      trigger: json['trigger'] as String,
      enabled: json['enabled'] as bool? ?? false,
      placementId: (json['placementId'] ?? json['placement_id']) as String?,
      variantId: json['variantId'] as String,
      variantKey: (json['variantKey'] ?? json['variant_key']) as String?,
      spec:
          PaywallSpec.fromJson(Map<String, dynamic>.from(json['spec'] as Map)),
    );
  }

  JsonMap toJson() => {
        'trigger': trigger,
        'enabled': enabled,
        if (placementId != null) 'placement_id': placementId,
        'variantId': variantId,
        if (variantKey != null) 'variant_key': variantKey,
        'spec': spec.toJson(),
      };
}

class ConfigResponse {
  const ConfigResponse({
    required this.version,
    required this.placements,
    required this.assets,
    required this.ttl,
    this.meta,
  });

  final String version;
  final Map<String, PlacementConfig?> placements;
  final AssetManifest assets;
  final int ttl;
  final JsonMap? meta;

  factory ConfigResponse.fromJson(JsonMap json) {
    final rawPlacements = Map<String, dynamic>.from(json['placements'] as Map);
    return ConfigResponse(
      version: json['version'] as String? ?? '1.0.0',
      placements: rawPlacements.map((key, value) {
        if (value == null) return MapEntry(key, null);
        return MapEntry(
          key,
          PlacementConfig.fromJson(Map<String, dynamic>.from(value as Map)),
        );
      }),
      assets: AssetManifest.fromJson(
        json['assets'] == null
            ? null
            : Map<String, dynamic>.from(json['assets'] as Map),
      ),
      ttl: (json['ttl'] as num? ?? 0).round(),
      meta: json['_meta'] == null
          ? null
          : Map<String, dynamic>.from(json['_meta'] as Map),
    );
  }

  JsonMap toJson() => {
        'version': version,
        'placements': placements.map(
          (key, value) => MapEntry(key, value?.toJson()),
        ),
        'assets': assets.toJson(),
        'ttl': ttl,
        if (meta != null) '_meta': meta,
      };
}

Map<String, String> _stringMap(Object? value) {
  if (value == null) return <String, String>{};
  return Map<String, dynamic>.from(value as Map).map(
    (key, val) => MapEntry(key.toString(), val.toString()),
  );
}

List<String>? _stringList(Object? value) {
  if (value == null) return null;
  return (value as List).map((item) => item.toString()).toList();
}
