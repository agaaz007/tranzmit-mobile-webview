import type { ServerResponse } from "node:http";

const API_BASE = process.env.API_BASE_URL || "https://tranzmit-api-production.up.railway.app";

export function getSnippet(publicKey: string): string {
  return `<!-- Tranzmit SDK -->
<script src="${API_BASE}/sdk/v1/tranzmit.js"></script>
<script>
  // 1. Initialize once (on page load or app startup)
  Tranzmit.init({
    publicKey: "${publicKey}",
    userId: YOUR_AUTH_USER_ID, // use your real auth/session user ID; do not generate random production IDs
    apiBaseUrl: "${API_BASE}"
  });

  // 2. Gate premium features — call this wherever you want a paywall
  //    The trigger name must match what you configured in the dashboard
  function gatePremiumFeature() {
    const result = Tranzmit.gate("upgrade_pro", {
      onCTA: function(product) {
        // User clicked subscribe — redirect to your checkout
        window.location.href = "/checkout?plan=" + product.id;
      },
      onDismiss: function() {
        // User closed the paywall
      }
    });

    if (!result.shown) {
      // No paywall for this trigger, or it's disabled — let user through
      proceedWithFeature();
    }
  }
</script>`;
}

export function serveSnippet(res: ServerResponse, publicKey: string): void {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(getSnippet(publicKey));
}
