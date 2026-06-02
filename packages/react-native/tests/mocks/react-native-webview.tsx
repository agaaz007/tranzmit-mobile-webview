import React, { useEffect } from "react";

export interface WebViewMessageEvent {
  nativeEvent: { data: string };
}

export interface WebViewNavigation {
  url: string;
}

export default function WebView({ source, onMessage, onError }: any) {
  const html = source?.html || "";
  useEffect(() => {
    if (html.includes("data-trigger-webview-error")) {
      onError?.({ nativeEvent: { description: "Simulated WebView failure" } });
    }
  }, [html, onError]);

  const body = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");
  const headings = Array.from(body.matchAll(/<(?:h1|h2|p)[^>]*>(.*?)<\/(?:h1|h2|p)>/gims))
    .map((match) => stripTags(match[1]));
  const buttons = Array.from(body.matchAll(/<button([^>]*)>(.*?)<\/button>/gims))
    .map((match) => {
      const attrs = match[1];
      return {
        action: attr(attrs, "data-tranzmit-action"),
        productId: attr(attrs, "data-product-id"),
        label: stripTags(match[2]),
      };
    })
    .filter((button) => button.action);

  return (
    <div data-testid="tranzmit-webview" data-html={html}>
      {headings.map((text) => (
        <span key={text}>{text}</span>
      ))}
      {buttons.map((button) => (
        <button
          key={`${button.action}:${button.productId || button.label}`}
          onClick={() => onMessage?.({ nativeEvent: { data: JSON.stringify({ type: button.action, productId: button.productId }) } })}
        >
          {button.label}
        </button>
      ))}
    </div>
  );
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string) {
  const match = attrs.match(new RegExp(`${name}=[\\"']([^\\\"']+)[\\"']`, "i"));
  return match?.[1];
}
