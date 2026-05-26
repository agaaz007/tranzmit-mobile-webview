import type { ServerResponse } from "node:http";

export function serveConfigDashboard(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_HTML);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tranzmit Mobile · Admin Console</title>
  <link rel="preconnect" href="https://rsms.me/">
  <link rel="stylesheet" href="https://rsms.me/inter/inter.css">
  <style>
    :root{
      --bg:#f4f5f8; --frame:#fff; --surface:#fff; --surface-soft:#fafbfc; --surface-hover:#f4f5f8;
      --ink:#0f1419; --ink-2:#2a313c; --muted:#5b6573; --muted-2:#8a93a1;
      --line:#e6e8ec; --line-strong:#d6d9df;
      --rail:#0f1419; --rail-2:#1a1f2b; --rail-ink:#9aa3b1; --rail-ink-active:#fff;
      --primary:#2563eb; --primary-hover:#1d4ed8; --primary-ink:#fff;
      --accent:#0f1419;
      --success:#0f9d58; --success-soft:#e7f7ee;
      --warning:#b54708; --warning-soft:#fef4e6;
      --danger:#b3261e; --danger-soft:#fde8e8;
      --chip:#eef0f4;
      --shadow-sm:0 1px 2px rgba(15,20,25,.05);
      --shadow-md:0 4px 12px rgba(15,20,25,.08);
      --shadow-lg:0 16px 36px rgba(15,20,25,.14);
      --radius-sm:6px; --radius:8px; --radius-lg:12px;
    }
    *{box-sizing:border-box}
    html,body{height:100%}
    body{margin:0;background:var(--bg);color:var(--ink);font-family:'Inter var',Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-feature-settings:'cv11','ss01','ss03';font-size:13.5px;line-height:1.45;-webkit-font-smoothing:antialiased}
    button,input,select,textarea{font:inherit;color:inherit}
    button{cursor:pointer}
    a{color:inherit;text-decoration:none}
    .frame{background:var(--frame);min-height:100vh;display:flex;flex-direction:column}
    /* App bar */
    .appbar{align-items:center;background:#fafbfc;border-bottom:1px solid var(--line);display:flex;gap:14px;height:48px;padding:0 14px}
    .appbar-brand{align-items:center;display:flex;gap:10px;flex:0 0 auto;min-width:0}
    .brand-mark{align-items:center;background:#0f1419;border-radius:9px;color:#fff;display:flex;height:30px;justify-content:center;width:30px}
    .brand-name{color:var(--ink);font-size:15px;font-weight:700;letter-spacing:-.01em}
    .appbar-active{flex:1;min-width:0;display:flex;align-items:center;gap:10px}
    .active-card{align-items:center;background:#fff;border:1px solid var(--line);border-radius:999px;display:inline-flex;gap:8px;padding:4px 8px 4px 4px;max-width:100%;min-width:0}
    .active-avatar{align-items:center;background:linear-gradient(135deg,#2563eb,#7c3aed);border-radius:999px;color:#fff;display:flex;font-size:10.5px;font-weight:700;height:24px;justify-content:center;width:24px}
    .active-meta{min-width:0;display:flex;flex-direction:column;line-height:1.1}
    .active-name{font-size:12.5px;font-weight:700;color:var(--ink);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .active-key{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--muted);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .appbar-controls{align-items:center;display:flex;gap:6px;color:var(--muted)}
    .icon-btn{align-items:center;background:transparent;border:none;border-radius:6px;color:var(--muted);display:inline-flex;height:32px;justify-content:center;width:32px}
    .icon-btn:hover{background:#eef0f4;color:var(--ink)}
    /* Body / rail */
    .body{display:grid;grid-template-columns:64px minmax(0,1fr);flex:1;min-height:0}
    .rail{background:var(--rail);color:var(--rail-ink);display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 0 14px}
    .rail-item{align-items:center;background:transparent;border:none;border-radius:10px;color:var(--rail-ink);display:flex;flex-direction:column;gap:2px;font-size:9.5px;font-weight:600;height:48px;justify-content:center;letter-spacing:.04em;text-transform:uppercase;transition:background .12s ease,color .12s ease;width:48px}
    .rail-item:hover{background:rgba(255,255,255,.06);color:#fff}
    .rail-item.active{background:rgba(255,255,255,.14);color:var(--rail-ink-active)}
    .rail-item svg{display:block}
    .rail-spacer{flex:1}
    .rail-bottom{color:var(--rail-ink)}
    .canvas{background:#fff;overflow:auto;min-width:0}
    .page{padding:20px 24px 32px;max-width:1480px;margin:0 auto;width:100%}
    .page-header{align-items:flex-end;display:flex;gap:14px;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap}
    .page-title{font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0}
    .page-sub{color:var(--muted);margin-top:4px;font-size:13px;max-width:680px}
    .row{align-items:center;display:flex;flex-wrap:wrap;gap:8px}
    .status-pill{align-items:center;background:var(--chip);border-radius:999px;color:var(--ink-2);display:inline-flex;font-size:12px;font-weight:600;gap:6px;padding:5px 10px}
    .status-pill.live{background:var(--success-soft);color:var(--success)}
    .status-pill.live::before{background:var(--success);border-radius:999px;content:'';height:7px;width:7px}
    .status-pill.warn{background:var(--warning-soft);color:var(--warning)}
    .status-pill.warn::before{background:var(--warning);border-radius:999px;content:'';height:7px;width:7px}
    /* Buttons */
    .btn{align-items:center;background:#fff;border:1px solid var(--line-strong);border-radius:7px;color:var(--ink);display:inline-flex;font-size:13px;font-weight:600;gap:6px;justify-content:center;min-height:32px;padding:6px 12px;transition:background .12s ease,border-color .12s ease}
    .btn:hover{background:var(--surface-hover)}
    .btn-primary{background:var(--ink);border-color:var(--ink);color:#fff}
    .btn-primary:hover{background:#000}
    .btn-accent{background:var(--primary);border-color:var(--primary);color:#fff}
    .btn-accent:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
    .btn-ghost{background:transparent;border-color:transparent;color:var(--muted)}
    .btn-ghost:hover{background:var(--surface-hover);color:var(--ink)}
    .btn-danger{background:#fff;border-color:#fbb6b6;color:var(--danger)}
    .btn-danger:hover{background:var(--danger-soft)}
    .btn-sm{font-size:12px;min-height:28px;padding:4px 9px}
    /* Cards */
    .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);margin-bottom:14px;overflow:hidden}
    .card-head{align-items:center;border-bottom:1px solid var(--line);display:flex;gap:12px;justify-content:space-between;padding:12px 16px}
    .card-title{font-size:13.5px;font-weight:700;letter-spacing:-.005em;margin:0}
    .card-sub{color:var(--muted);font-size:12.5px;margin-top:2px}
    .card-body{padding:16px}
    .stack{display:grid;gap:12px}
    .grid-2{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}
    .grid-3{display:grid;gap:12px;grid-template-columns:repeat(3,minmax(0,1fr))}
    .grid-split{display:grid;gap:14px;grid-template-columns:minmax(0,1.35fr) minmax(0,.65fr);align-items:start}
    .field{display:grid;gap:6px}
    .field-label{color:var(--muted);font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
    .toggle-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--surface-sub);font-size:13px;color:var(--text)}
    .toggle-row input[type="checkbox"]{margin-top:2px;width:14px;height:14px;accent-color:var(--accent)}
    input,select,textarea{background:#fff;border:1px solid var(--line-strong);border-radius:7px;color:var(--ink);min-height:34px;outline:none;padding:7px 10px;transition:border-color .12s ease,box-shadow .12s ease;width:100%}
    input:hover,select:hover{border-color:#c2c6cd}
    input:focus,select:focus,textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(37,99,235,.14)}
    textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;min-height:200px;resize:vertical}
    select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%235b6573' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:30px}
    .actions{display:flex;gap:8px;justify-content:flex-end;padding-top:4px}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
    /* Tags */
    .tag{align-items:center;background:var(--chip);border-radius:999px;color:var(--ink-2);display:inline-flex;font-size:11.5px;font-weight:600;padding:3px 8px}
    .tag.green{background:var(--success-soft);color:var(--success)}
    .tag.blue{background:#e5edff;color:#1d4ed8}
    .tag.purple{background:#f0e6ff;color:#6537d9}
    .tag.gray{background:var(--chip);color:#475467}
    .tag.warn{background:var(--warning-soft);color:var(--warning)}
    .tag.danger{background:var(--danger-soft);color:var(--danger)}
    /* Client cards (clients page) */
    .client-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
    .client-card{align-items:flex-start;background:#fff;border:1px solid var(--line);border-radius:var(--radius-lg);cursor:pointer;display:flex;flex-direction:column;gap:10px;padding:14px 14px 12px;text-align:left;transition:border-color .12s ease,box-shadow .12s ease;width:100%}
    .client-card:hover{border-color:var(--line-strong);box-shadow:var(--shadow-sm)}
    .client-card.active{border-color:var(--primary);box-shadow:0 0 0 2px rgba(37,99,235,.14)}
    .client-card-head{align-items:center;display:flex;gap:10px;width:100%}
    .client-avatar{align-items:center;background:linear-gradient(135deg,#2563eb,#7c3aed);border-radius:10px;color:#fff;display:flex;font-size:13px;font-weight:700;height:36px;justify-content:center;letter-spacing:.04em;width:36px;flex-shrink:0}
    .client-name{font-size:14px;font-weight:700;letter-spacing:-.01em}
    .client-meta{color:var(--muted);font-size:11.5px}
    .client-tags{align-items:center;display:flex;flex-wrap:wrap;gap:6px}
    .client-actions{align-items:center;display:flex;gap:6px;margin-top:auto;padding-top:4px;width:100%;justify-content:flex-end}
    /* Tables */
    .table{display:flex;flex-direction:column}
    .table-row{align-items:center;border-top:1px solid var(--line);display:grid;gap:12px;grid-template-columns:24px minmax(0,1fr) auto auto;padding:11px 16px;transition:background .12s ease}
    .table-row:first-child{border-top:none}
    .table-row:hover{background:var(--surface-soft)}
    .table-row.active{background:#f1f5fd}
    .avatar{align-items:center;background:#eef0f4;border-radius:6px;color:var(--ink-2);display:flex;font-size:10.5px;font-weight:700;height:24px;justify-content:center;letter-spacing:.04em;width:24px}
    .avatar.lib{background:#e5edff;color:#1d4ed8}
    .avatar.pl{background:#fdeed7;color:#9a5a05}
    .avatar.ev{background:#f0e6ff;color:#6537d9}
    .row-title{font-size:13px;font-weight:600;letter-spacing:-.005em}
    .row-meta{color:var(--muted);font-size:12px;margin-top:2px;word-break:break-word}
    .empty{color:var(--muted);font-size:12.5px;padding:14px 16px}
    /* Variants list */
    .variant{align-items:center;border:1px solid var(--line);border-radius:8px;display:grid;gap:10px;grid-template-columns:auto 1fr auto auto auto;padding:8px 10px;background:#fff}
    .variant + .variant{margin-top:6px}
    .variant-key{align-items:center;background:#eef0f4;border-radius:6px;color:var(--ink-2);display:inline-flex;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;font-weight:700;padding:3px 8px}
    .weight-input{width:64px;min-height:28px;padding:4px 8px}
    /* Code blocks */
    .code{background:#0f1419;border-radius:10px;color:#e6e8ec;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;overflow:auto;padding:14px 16px;white-space:pre;position:relative}
    .copy-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#fff;font-size:11px;font-weight:600;padding:4px 8px;position:absolute;right:10px;top:10px}
    .copy-btn:hover{background:rgba(255,255,255,.16)}
    .secret-reveal{align-items:center;background:#fffaf0;border:1px dashed #f0c46a;border-radius:8px;color:var(--warning);display:flex;font-size:12.5px;gap:8px;padding:10px 12px}
    /* Preview card */
    .preview-card{background:linear-gradient(180deg,#fff,#fbfaff);border:1px solid #e9e3f8;border-radius:14px;padding:0;overflow:hidden}
    .preview-frame{display:block;width:100%;height:560px;border:0;background:transparent}
    .preview-logo{color:#6537d9;font-size:12px;font-weight:800;letter-spacing:.04em;text-align:center;text-transform:uppercase}
    .preview-title{color:#17172e;font-size:21px;font-weight:800;letter-spacing:-.02em;line-height:1.15;margin-top:8px;text-align:center;white-space:pre-line}
    .preview-subtitle{color:#6f6878;font-size:12.5px;line-height:1.4;margin:6px auto 0;max-width:300px;text-align:center}
    .preview-offer{background:#fff;border:1px solid #ece4fb;border-radius:14px;margin-top:12px;padding:14px;text-align:center}
    .preview-badge{background:#e6b246;border-radius:6px;color:#fff;display:inline-flex;font-size:10px;font-weight:800;letter-spacing:.06em;margin-bottom:6px;padding:3px 8px;text-transform:uppercase}
    .preview-product{color:#6537d9;font-size:20px;font-weight:800}
    .preview-price{color:#17172e;font-size:13.5px;font-weight:700;margin-top:2px}
    .preview-features{display:grid;gap:6px;margin-top:10px}
    .preview-feature{align-items:center;background:#fff;border:1px solid #f0edf7;border-radius:8px;display:flex;gap:8px;padding:7px 9px;font-size:12.5px}
    .preview-dot{background:#6537d9;border-radius:999px;height:7px;width:7px;flex-shrink:0}
    .advanced{border-top:1px dashed var(--line-strong);margin-top:8px;padding-top:10px}
    .advanced summary{color:var(--muted);cursor:pointer;font-size:12px;font-weight:600}
    .advanced[open] summary{margin-bottom:10px}
    /* Modal / drawer */
    .scrim{align-items:flex-start;background:rgba(15,20,25,.45);display:none;inset:0;justify-content:flex-end;padding:24px;position:fixed;z-index:40}
    .scrim.show{display:flex}
    .modal{background:#fff;border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);display:flex;flex-direction:column;max-width:560px;max-height:calc(100vh - 48px);overflow:hidden;width:100%}
    .modal.drawer{max-width:640px;height:calc(100vh - 48px)}
    .modal-head{align-items:center;border-bottom:1px solid var(--line);display:flex;gap:12px;justify-content:space-between;padding:14px 18px}
    .modal-title{font-size:15px;font-weight:700;letter-spacing:-.01em}
    .modal-body{overflow:auto;padding:18px}
    .modal-foot{align-items:center;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end;padding:12px 18px}
    /* Toast */
    .toast{background:#0f1419;border-radius:8px;bottom:24px;box-shadow:var(--shadow-lg);color:#fff;font-size:13px;opacity:0;padding:9px 13px;position:fixed;right:24px;transform:translateY(8px);transition:.18s ease;z-index:30}
    .toast.show{opacity:1;transform:translateY(0)}
    /* Pages visibility */
    .view{display:none}
    .view.active{display:block}
    .hint{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;color:#1e3a8a;font-size:12.5px;line-height:1.5;padding:10px 12px}
    .hint b{color:#0f1419}
    @media(max-width:1280px){.grid-split{grid-template-columns:1fr}}
    @media(max-width:980px){.page{padding:16px 18px 24px}.grid-3{grid-template-columns:repeat(2,minmax(0,1fr))}.client-grid{grid-template-columns:1fr}}
    @media(max-width:720px){.body{grid-template-columns:1fr}.rail{display:none}.grid-2,.grid-3{grid-template-columns:1fr}.appbar{padding:0 10px}.appbar-active{display:none}.scrim{padding:0}.modal{border-radius:0;max-height:100vh;height:100vh;max-width:100vw}.modal.drawer{height:100vh;max-width:100vw}}
  </style>
</head>
<body>
  <div class="frame">
    <header class="appbar">
      <div class="appbar-brand">
        <span class="brand-mark"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.5l5.5 3.25v6.5L8 14.5 2.5 11.25v-6.5L8 1.5z" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="#fff"/></svg></span>
        <span class="brand-name">Tranzmit Mobile</span>
      </div>
      <div class="appbar-active" id="activeClientBar"></div>
      <div class="appbar-controls">
        <button class="btn btn-ghost btn-sm" id="settingsBtn"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.4"/><path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.7 2.7l1.1 1.1M10.2 10.2l1.1 1.1M2.7 11.3l1.1-1.1M10.2 3.8l1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>API</button>
        <span class="status-pill live" id="apiStatus">Live</span>
      </div>
    </header>
    <div class="body">
      <nav class="rail" aria-label="Primary">
        <button class="rail-item active" data-nav="clients" title="Clients">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 17c.5-3.4 3.2-5 6.5-5s6 1.6 6.5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          <span>Clients</span>
        </button>
        <button class="rail-item" data-nav="paywalls" title="Paywalls">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="3.5" y="3.5" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 7.5h13M7.5 16.5v-9" stroke="currentColor" stroke-width="1.6"/></svg>
          <span>Paywalls</span>
        </button>
        <button class="rail-item" data-nav="placements" title="Placements">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3.5 6L10 3l6.5 3M3.5 6v8L10 17m-6.5-11L10 9m6.5-3v8L10 17m6.5-11L10 9m0 0v8" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
          <span>Slots</span>
        </button>
        <button class="rail-item" data-nav="events" title="Events">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3.5 16V8m4 8V5m4 11v-4m4 4V8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          <span>Events</span>
        </button>
        <div class="rail-spacer"></div>
        <button class="rail-item rail-bottom" id="navHelp" title="Help">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M7.8 8.4c.3-1.1 1.2-1.7 2.2-1.7 1.3 0 2.2.9 2.2 2 0 1-.7 1.4-1.4 1.9-.5.4-.8.7-.8 1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="14.6" r="1" fill="currentColor"/></svg>
          <span>Help</span>
        </button>
      </nav>
      <main class="canvas">
        <div class="page">
          <!-- ===================== CLIENTS PAGE ===================== -->
          <section class="view active" id="view-clients">
            <div class="page-header">
              <div>
                <h1 class="page-title">Clients</h1>
                <div class="page-sub">Each client gets its own public key (the SDK install token) plus a Railway env var that holds their Statsig server secret. Switch the active client to manage their paywalls.</div>
              </div>
              <div class="row">
                <select id="clientStackFilter" style="width:150px;"><option value="all">All stacks</option><option value="react_native">RN</option><option value="flutter">Flutter</option><option value="swift">Swift</option></select>
                <button class="btn" id="refreshClientsBtn"><svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2.5 7a4.5 4.5 0 1 0 1.5-3.4M2.5 2.5V5H5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Refresh</button>
                <button class="btn btn-accent" id="newClientBtn"><svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>New client</button>
              </div>
            </div>
            <div class="hint" id="clientsHint" style="margin-bottom:14px;">
              <b>How this works.</b> Create a client → choose its app stack → copy the public key into the SDK provider, set the printed env var on Railway with the matching Statsig server secret, and Tranzmit starts serving paywalls + forwarding events for that client.
            </div>
            <div class="client-grid" id="clientGrid"></div>
          </section>

          <!-- ===================== PAYWALLS PAGE ===================== -->
          <section class="view" id="view-paywalls">
            <div class="page-header">
              <div>
                <h1 class="page-title">Paywalls</h1>
                <div class="page-sub">Reusable paywall specs in this workspace. Edits hot-swap into the SDK on the next config fetch.</div>
              </div>
              <div class="row">
                <span class="tag gray" id="paywallsClientTag">no client</span>
                <button class="btn" id="refreshPaywallsBtn">Refresh</button>
              </div>
            </div>
            <div class="grid-split">
              <div>
                <section class="card" id="editor">
                  <div class="card-head">
                    <div><div class="card-title">Editor</div><div class="card-sub">Mutate server-driven fields. Saving hot-swaps the live paywall.</div></div>
                    <span class="tag gray" id="editorKind">spec</span>
                  </div>
                  <div class="card-body stack">
                    <div class="field"><span class="field-label">Spec</span><select id="editSpec"></select></div>
                    <div class="grid-2">
                      <div class="field"><span class="field-label">Headline</span><input id="fieldTitle" class="spec-field"></div>
                      <div class="field"><span class="field-label">Subtitle</span><input id="fieldSubtitle" class="spec-field"></div>
                      <div class="field"><span class="field-label">CTA</span><input id="fieldCta" class="spec-field"></div>
                      <div class="field"><span class="field-label">Presentation</span><select id="fieldPresentation" class="spec-field"><option value="sheet">Popup sheet</option><option value="modal">Centered popup</option><option value="fullscreen">Full screen</option><option value="inline">Inline</option></select></div>
                      <div class="field"><span class="field-label">Footer / Legal</span><input id="fieldLegal" class="spec-field"></div>
                    </div>
                    <div class="grid-3">
                      <div class="field"><span class="field-label">Product name</span><input id="fieldProductName" class="spec-field"></div>
                      <div class="field"><span class="field-label">Price</span><input id="fieldProductPrice" class="spec-field"></div>
                      <div class="field"><span class="field-label">Original price</span><input id="fieldOriginalPrice" class="spec-field"></div>
                      <div class="field"><span class="field-label">Badge</span><input id="fieldBadge" class="spec-field"></div>
                      <div class="field"><span class="field-label">Monthly copy</span><input id="fieldMonthly" class="spec-field"></div>
                      <div class="field"><span class="field-label">Social proof</span><input id="fieldSocialProof" class="spec-field"></div>
                    </div>
                    <div class="grid-2">
                      <div class="field"><span class="field-label">Feature 1</span><input id="fieldFeature1" class="spec-field"></div>
                      <div class="field"><span class="field-label">Feature 2</span><input id="fieldFeature2" class="spec-field"></div>
                      <div class="field"><span class="field-label">Feature 3</span><input id="fieldFeature3" class="spec-field"></div>
                      <div class="field"><span class="field-label">Feature 4</span><input id="fieldFeature4" class="spec-field"></div>
                    </div>
                    <div class="grid-3">
                      <div class="field"><span class="field-label">Testimonial name</span><input id="fieldTestimonialName" class="spec-field"></div>
                      <div class="field"><span class="field-label">Followers</span><input id="fieldTestimonialFollowers" class="spec-field"></div>
                      <div class="field"><span class="field-label">Testimonial text</span><input id="fieldTestimonialText" class="spec-field"></div>
                      <div class="field"><span class="field-label">Accent color</span><input id="fieldAccentColor" class="spec-field"></div>
                      <div class="field"><span class="field-label">Background</span><input id="fieldBackgroundColor" class="spec-field"></div>
                      <div class="field"><span class="field-label">Text color</span><input id="fieldTextColor" class="spec-field"></div>
                    </div>
                    <details class="advanced">
                      <summary>Advanced JSON</summary>
                      <textarea id="editJson"></textarea>
                      <div class="card-sub" style="margin-top:6px;">Fields above take precedence on save; unknown keys are preserved.</div>
                    </details>
                    <div class="actions">
                      <button class="btn" id="loadSpecBtn">Reset fields</button>
                      <button class="btn btn-accent" id="saveSpecBtn">Save hot-swap</button>
                    </div>
                  </div>
                </section>
              </div>
              <div>
                <section class="card">
                  <div class="card-head"><div><div class="card-title">Preview</div><div class="card-sub">Content-level preview of the selected spec.</div></div></div>
                  <div class="card-body"><div id="specPreview" class="preview-card"></div></div>
                </section>
                <section class="card" id="library">
                  <div class="card-head"><div><div class="card-title">Spec library</div><div class="card-sub">All specs for this client.</div></div><span class="tag gray" id="specCount">0</span></div>
                  <div class="table" id="specs"></div>
                </section>
              </div>
            </div>
          </section>

          <!-- ===================== PLACEMENTS PAGE ===================== -->
          <section class="view" id="view-placements">
            <div class="page-header">
              <div>
                <h1 class="page-title">Placement slots &amp; experiments</h1>
                <div class="page-sub">Each placement (a trigger in your app) serves a default spec, optionally overridden by a Statsig experiment. Variants below map experiment values (control / test_1 / test_2 / ...) to specs.</div>
              </div>
              <div class="row">
                <span class="tag gray" id="placementsClientTag">no client</span>
                <button class="btn" id="refreshPlacementsBtn">Refresh</button>
                <button class="btn btn-accent" id="fetchPreviewBtn">Preview SDK config</button>
              </div>
            </div>
            <div id="placementsList"></div>
          </section>

          <!-- ===================== EVENTS PAGE ===================== -->
          <section class="view" id="view-events">
            <div class="page-header">
              <div>
                <h1 class="page-title">Events</h1>
                <div class="page-sub">Recent events ingested for all clients. Each one is also forwarded to the client's Statsig project (prefixed <span class="mono">tranzmit_</span>).</div>
              </div>
              <div class="row">
                <button class="btn" id="refreshEventsBtn">Refresh</button>
              </div>
            </div>
            <section class="card">
              <div class="card-head"><div><div class="card-title">Recent events</div><div class="card-sub">Last 50 events ingested at <span class="mono">POST /v1/events</span>.</div></div></div>
              <div class="table" id="events"></div>
            </section>
          </section>
        </div>
      </main>
    </div>
  </div>

  <!-- ===================== API SETTINGS MODAL ===================== -->
  <div class="scrim" id="settingsScrim">
    <div class="modal" style="margin:auto;">
      <div class="modal-head"><div class="modal-title">API connection</div><button class="icon-btn" data-close-modal><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
      <div class="modal-body stack">
        <div class="field"><span class="field-label">API base URL</span><input id="apiBase"></div>
        <div class="field"><span class="field-label">Admin secret</span><input id="adminSecret" type="password" placeholder="ADMIN_SECRET from Railway"></div>
        <div class="hint">The admin secret is required to manage clients. Set it on the server as <span class="mono">ADMIN_SECRET</span>.</div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close-modal>Cancel</button>
        <button class="btn btn-accent" id="saveSettingsBtn">Save</button>
      </div>
    </div>
  </div>

  <!-- ===================== NEW CLIENT MODAL ===================== -->
  <div class="scrim" id="newClientScrim">
    <div class="modal" style="margin:auto;">
      <div class="modal-head"><div class="modal-title">New client</div><button class="icon-btn" data-close-modal><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
      <div class="modal-body stack">
        <div class="field"><span class="field-label">Client name</span><input id="newClientName" placeholder="e.g. Acme Mobile" autocomplete="off"></div>
        <div class="field"><span class="field-label">Environment</span><select id="newClientEnv"><option value="test">Test</option><option value="live">Live</option></select></div>
        <div class="field"><span class="field-label">App stack</span><select id="newClientStack"><option value="react_native">RN / React Native</option><option value="flutter">Flutter</option><option value="swift">Swift</option></select></div>
        <label class="toggle-row" for="newClientStatsigToggle">
          <input type="checkbox" id="newClientStatsigToggle">
          <span><b>Connect Statsig (optional)</b><span class="card-sub" style="display:block;margin-top:2px;">Skip this for a plain SDK install. You can enable Statsig later from the client setup drawer.</span></span>
        </label>
        <div id="newClientStatsigFields" class="stack" style="display:none;">
          <div class="field"><span class="field-label">Statsig project name</span><input id="newClientStatsigProject" placeholder="e.g. acme-mobile" autocomplete="off"></div>
          <div class="field">
            <span class="field-label">Statsig server secret env var</span>
            <input id="newClientStatsigEnv" placeholder="STATSIG_SERVER_SECRET_ACME">
            <div class="card-sub">Auto-suggested from the client name. You'll set this env var on Railway with the Statsig server secret for this client's project.</div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close-modal>Cancel</button>
        <button class="btn btn-accent" id="createClientBtn">Create client</button>
      </div>
    </div>
  </div>

  <!-- ===================== CLIENT SETUP DRAWER ===================== -->
  <div class="scrim" id="setupScrim">
    <div class="modal drawer">
      <div class="modal-head"><div class="modal-title" id="setupTitle">Client setup</div><button class="icon-btn" data-close-modal><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
      <div class="modal-body stack" id="setupBody"></div>
      <div class="modal-foot">
        <button class="btn" data-close-modal>Close</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    /* ===================== STATE ===================== */
    var state = {
      apiBase: '',
      adminSecret: '',
      clients: [],
      activeClientId: null,
      specs: [],
      placements: [],
      events: [],
      page: 'clients',
      sdkStackFilter: 'all',
      lastCreatedSecretKey: null,
    };
    var els = {};
    var fieldIds = ['fieldTitle','fieldSubtitle','fieldCta','fieldPresentation','fieldLegal','fieldProductName','fieldProductPrice','fieldOriginalPrice','fieldBadge','fieldMonthly','fieldSocialProof','fieldFeature1','fieldFeature2','fieldFeature3','fieldFeature4','fieldTestimonialName','fieldTestimonialFollowers','fieldTestimonialText','fieldAccentColor','fieldBackgroundColor','fieldTextColor'];

    document.addEventListener('DOMContentLoaded', function() {
      [
        'apiStatus','activeClientBar','clientGrid','clientsHint','clientStackFilter','refreshClientsBtn','newClientBtn',
        'paywallsClientTag','refreshPaywallsBtn','editSpec','editJson','loadSpecBtn','saveSpecBtn','editorKind','specPreview','specs','specCount',
        'placementsClientTag','refreshPlacementsBtn','placementsList','fetchPreviewBtn',
        'refreshEventsBtn','events',
        'settingsBtn','settingsScrim','apiBase','adminSecret','saveSettingsBtn',
        'newClientScrim','newClientName','newClientEnv','newClientStack','newClientStatsigToggle','newClientStatsigFields','newClientStatsigProject','newClientStatsigEnv','createClientBtn',
        'setupScrim','setupTitle','setupBody',
        'toast'
      ].concat(fieldIds).forEach(function(id) { els[id] = document.getElementById(id); });

      state.apiBase = localStorage.getItem('tranzmit:apiBase') || window.location.origin;
      state.adminSecret = localStorage.getItem('tranzmit:adminSecret') || '';
      state.activeClientId = localStorage.getItem('tranzmit:activeClientId') || null;
      state.sdkStackFilter = localStorage.getItem('tranzmit:sdkStackFilter') || 'all';
      els.apiBase.value = state.apiBase;
      els.adminSecret.value = state.adminSecret;
      els.clientStackFilter.value = state.sdkStackFilter;

      // Nav
      Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function(btn) {
        btn.addEventListener('click', function() { setPage(btn.getAttribute('data-nav')); });
      });
      els.settingsBtn.addEventListener('click', function() { openModal('settingsScrim'); });
      els.saveSettingsBtn.addEventListener('click', saveSettings);

      // Clients
      els.refreshClientsBtn.addEventListener('click', loadClients);
      els.newClientBtn.addEventListener('click', openNewClient);
      els.createClientBtn.addEventListener('click', createClient);
      els.clientStackFilter.addEventListener('change', function() {
        state.sdkStackFilter = els.clientStackFilter.value || 'all';
        localStorage.setItem('tranzmit:sdkStackFilter', state.sdkStackFilter);
        renderClients();
      });
      els.newClientName.addEventListener('input', autoFillStatsigEnv);
      els.newClientStatsigToggle.addEventListener('change', function() {
        els.newClientStatsigFields.style.display = els.newClientStatsigToggle.checked ? '' : 'none';
        if (els.newClientStatsigToggle.checked) autoFillStatsigEnv();
      });

      // Paywalls
      els.refreshPaywallsBtn.addEventListener('click', function() { loadClientData(); });
      els.editSpec.addEventListener('change', loadSelectedSpec);
      els.loadSpecBtn.addEventListener('click', loadSelectedSpec);
      els.saveSpecBtn.addEventListener('click', saveSelectedSpec);
      fieldIds.forEach(function(id) { els[id].addEventListener('input', function() { syncFieldsIntoJson(false); renderPreviewFromEditor(); }); });

      // Placements
      els.refreshPlacementsBtn.addEventListener('click', function() { loadClientData(); });
      els.fetchPreviewBtn.addEventListener('click', previewLiveConfig);

      // Events
      els.refreshEventsBtn.addEventListener('click', loadEvents);

      // Modals
      Array.prototype.forEach.call(document.querySelectorAll('[data-close-modal]'), function(btn) {
        btn.addEventListener('click', function() {
          var scrim = btn.closest('.scrim');
          if (scrim) scrim.classList.remove('show');
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll('.scrim'), function(scrim) {
        scrim.addEventListener('click', function(e) { if (e.target === scrim) scrim.classList.remove('show'); });
      });

      // Initial load
      loadClients().then(function() {
        if (state.activeClientId && getClient(state.activeClientId)) {
          loadClientData();
        }
      });
    });

    /* ===================== HELPERS ===================== */
    function base() { return state.apiBase.replace(/\\/$/, ''); }
    function headers() {
      var h = { 'Content-Type': 'application/json' };
      if (state.adminSecret) h['X-Admin-Secret'] = state.adminSecret;
      return h;
    }
    function activeClient() { return getClient(state.activeClientId); }
    function getClient(id) { return state.clients.find(function(c) { return c.id === id; }); }
    function persistActive() {
      if (state.activeClientId) localStorage.setItem('tranzmit:activeClientId', state.activeClientId);
      else localStorage.removeItem('tranzmit:activeClientId');
    }
    function saveSettings() {
      state.apiBase = els.apiBase.value.trim() || window.location.origin;
      state.adminSecret = els.adminSecret.value.trim();
      localStorage.setItem('tranzmit:apiBase', state.apiBase);
      localStorage.setItem('tranzmit:adminSecret', state.adminSecret);
      closeModal('settingsScrim');
      toast('Settings saved');
      loadClients();
    }

    async function api(path, options) {
      var res = await fetch(base() + path, Object.assign({ headers: headers() }, options || {}));
      var text = await res.text();
      var json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
      if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
      return json;
    }

    function setStatus(label, kind) { els.apiStatus.textContent = label; els.apiStatus.className = 'status-pill ' + (kind || ''); }

    function setPage(page) {
      state.page = page;
      Array.prototype.forEach.call(document.querySelectorAll('.rail-item[data-nav]'), function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-nav') === page);
      });
      Array.prototype.forEach.call(document.querySelectorAll('.view'), function(view) {
        view.classList.toggle('active', view.id === 'view-' + page);
      });
      if (page !== 'clients' && !state.activeClientId) {
        toast('Select a client first');
        setPage('clients');
        return;
      }
      if (page === 'paywalls') renderPaywalls();
      else if (page === 'placements') renderPlacements();
      else if (page === 'events') loadEvents();
    }

    function openModal(id) { document.getElementById(id).classList.add('show'); }
    function closeModal(id) { document.getElementById(id).classList.remove('show'); }

    function toast(message) {
      els.toast.textContent = message;
      els.toast.classList.add('show');
      clearTimeout(window.__toastTimer);
      window.__toastTimer = setTimeout(function() { els.toast.classList.remove('show'); }, 2600);
    }

    function escHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
        return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch];
      });
    }
    function escAttr(value) { return escHtml(value).replace(/\\n/g, ' '); }
    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() { toast('Copied'); }).catch(function() { fallbackCopy(text); });
      } else fallbackCopy(text);
    }
    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-9999px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch (_) { toast('Copy failed'); }
      document.body.removeChild(ta);
    }
    function initials(name) {
      var parts = (name || '').split(/\\s+/).filter(Boolean);
      return ((parts[0] && parts[0][0]) || 'C').toUpperCase() + ((parts[1] && parts[1][0]) || (parts[0] && parts[0][1]) || '').toUpperCase();
    }
    function sdkStackLabel(stack) {
      if (stack === 'flutter') return 'Flutter';
      if (stack === 'swift') return 'Swift';
      return 'RN';
    }
    function sdkStackTagKind(stack) {
      if (stack === 'flutter') return 'purple';
      if (stack === 'swift') return 'blue';
      return 'gray';
    }

    function renderActiveClientBar() {
      var client = activeClient();
      if (!client) {
        els.activeClientBar.innerHTML = '<span class="card-sub" style="font-size:12px;">No client selected — create one in the Clients tab.</span>';
        els.paywallsClientTag.textContent = 'no client';
        els.placementsClientTag.textContent = 'no client';
        return;
      }
      var statusKind = client.statsig_configured ? 'green' : 'warn';
      var statusLabel = client.statsig_configured ? (client.statsig_initialized ? 'Statsig ready' : 'Statsig configured') : 'Statsig env missing';
      els.activeClientBar.innerHTML =
        '<div class="active-card">' +
          '<span class="active-avatar">' + escHtml(initials(client.name)) + '</span>' +
          '<span class="active-meta">' +
            '<span class="active-name">' + escHtml(client.name) + '</span>' +
            '<span class="active-key">' + escHtml(client.public_key) + '</span>' +
          '</span>' +
        '</div>' +
        '<span class="tag ' + sdkStackTagKind(client.sdk_stack) + '">' + escHtml(sdkStackLabel(client.sdk_stack)) + '</span>' +
        '<span class="tag ' + statusKind + '">' + escHtml(statusLabel) + '</span>' +
        '<button class="btn btn-ghost btn-sm" id="viewSetupBtn">View setup</button>' +
        '<button class="btn btn-ghost btn-sm" id="clearActiveBtn">Switch</button>';
      var viewBtn = document.getElementById('viewSetupBtn');
      var clearBtn = document.getElementById('clearActiveBtn');
      if (viewBtn) viewBtn.addEventListener('click', function() { openSetupDrawer(client.id); });
      if (clearBtn) clearBtn.addEventListener('click', function() { setPage('clients'); });
      els.paywallsClientTag.textContent = client.name;
      els.placementsClientTag.textContent = client.name;
    }

    /* ===================== CLIENTS PAGE ===================== */
    async function loadClients() {
      try {
        setStatus('Loading', 'warn');
        if (!state.adminSecret) {
          els.clientGrid.innerHTML = '<div class="hint" style="grid-column:1/-1;"><b>Set the admin secret first.</b> Click the <span class="mono">API</span> button in the top bar to enter the ADMIN_SECRET configured on your Railway service.</div>';
          setStatus('Auth needed', 'warn');
          renderActiveClientBar();
          return;
        }
        state.clients = await api('/admin/clients');
        if (state.activeClientId && !getClient(state.activeClientId)) state.activeClientId = null;
        if (!state.activeClientId && state.clients.length > 0) {
          // Try to pick previously-stored pk_test_demo by default
          var demo = state.clients.find(function(c) { return c.public_key === 'pk_test_demo'; });
          state.activeClientId = (demo || state.clients[0]).id;
        }
        persistActive();
        renderClients();
        renderActiveClientBar();
        setStatus('Live', 'live');
      } catch (err) {
        setStatus('Error', 'warn');
        toast(err.message || 'Failed to load clients');
        els.clientGrid.innerHTML = '<div class="hint" style="grid-column:1/-1;color:#b3261e;border-color:#fbb6b6;background:#fde8e8;">' + escHtml(err.message || 'Failed to load clients') + '</div>';
      }
    }

    function renderClients() {
      if (!state.clients.length) {
        els.clientGrid.innerHTML = '<div class="hint" style="grid-column:1/-1;">No clients yet. Click <b>New client</b> to generate the first SDK install token.</div>';
        return;
      }
      var visibleClients = state.clients.filter(function(client) {
        return state.sdkStackFilter === 'all' || (client.sdk_stack || 'react_native') === state.sdkStackFilter;
      });
      if (!visibleClients.length) {
        els.clientGrid.innerHTML = '<div class="hint" style="grid-column:1/-1;">No ' + escHtml(sdkStackLabel(state.sdkStackFilter)) + ' clients yet. Change the stack filter or create a new client.</div>';
        return;
      }
      els.clientGrid.innerHTML = visibleClients.map(function(client) {
        var isActive = client.id === state.activeClientId;
        var sdkStack = client.sdk_stack || 'react_native';
        var statsigEnabled = client.statsig_enabled === true;
        var statusKind, statusLabel;
        if (!statsigEnabled) { statusKind = 'gray'; statusLabel = 'Statsig off'; }
        else if (client.statsig_configured) {
          statusKind = client.statsig_initialized ? 'green' : 'blue';
          statusLabel = client.statsig_initialized ? 'Statsig ready' : 'Awaiting init';
        } else { statusKind = 'warn'; statusLabel = 'Statsig env missing'; }
        return '<button type="button" class="client-card' + (isActive ? ' active' : '') + '" data-client="' + escAttr(client.id) + '">' +
          '<div class="client-card-head">' +
            '<span class="client-avatar">' + escHtml(initials(client.name)) + '</span>' +
            '<div style="min-width:0;flex:1;">' +
              '<div class="client-name">' + escHtml(client.name) + '</div>' +
              '<div class="client-meta mono">' + escHtml(client.public_key) + '</div>' +
            '</div>' +
            (isActive ? '<span class="tag blue">Active</span>' : '') +
          '</div>' +
          '<div class="client-tags">' +
            '<span class="tag ' + sdkStackTagKind(sdkStack) + '">' + escHtml(sdkStackLabel(sdkStack)) + '</span>' +
            '<span class="tag ' + statusKind + '">' + escHtml(statusLabel) + '</span>' +
            (statsigEnabled && client.statsig_server_secret_env_var ? '<span class="tag gray mono">' + escHtml(client.statsig_server_secret_env_var) + '</span>' : '') +
            (statsigEnabled && client.statsig_project_name ? '<span class="tag purple">' + escHtml(client.statsig_project_name) + '</span>' : '') +
          '</div>' +
          '<div class="client-actions">' +
            '<span class="btn btn-ghost btn-sm" data-setup="' + escAttr(client.id) + '">Setup</span>' +
            '<span class="btn btn-sm" data-select="' + escAttr(client.id) + '">' + (isActive ? 'Selected' : 'Select') + '</span>' +
          '</div>' +
        '</button>';
      }).join('');
      Array.prototype.forEach.call(els.clientGrid.querySelectorAll('[data-client]'), function(card) {
        card.addEventListener('click', function(e) {
          var setupTarget = e.target.closest('[data-setup]');
          if (setupTarget) { e.stopPropagation(); openSetupDrawer(setupTarget.getAttribute('data-setup')); return; }
          var selectTarget = e.target.closest('[data-select]');
          if (selectTarget) { e.stopPropagation(); selectClient(selectTarget.getAttribute('data-select')); return; }
          selectClient(card.getAttribute('data-client'));
        });
      });
    }

    function selectClient(id) {
      state.activeClientId = id;
      persistActive();
      renderClients();
      renderActiveClientBar();
      loadClientData();
      toast('Switched to ' + getClient(id).name);
    }

    /* ===================== NEW CLIENT ===================== */
    function openNewClient() {
      els.newClientName.value = '';
      els.newClientEnv.value = 'test';
      els.newClientStack.value = 'react_native';
      els.newClientStatsigProject.value = '';
      els.newClientStatsigEnv.value = '';
      els.newClientStatsigEnv.dataset.touched = '';
      els.newClientStatsigToggle.checked = false;
      els.newClientStatsigFields.style.display = 'none';
      openModal('newClientScrim');
      setTimeout(function() { els.newClientName.focus(); }, 60);
    }
    function autoFillStatsigEnv() {
      if (!els.newClientStatsigToggle.checked) return;
      if (els.newClientStatsigEnv.value && els.newClientStatsigEnv.dataset.touched === 'true') return;
      var slug = (els.newClientName.value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
      els.newClientStatsigEnv.value = slug ? 'STATSIG_SERVER_SECRET_' + slug : '';
    }
    els = els || {};
    document.addEventListener('input', function(e) { if (e.target === els.newClientStatsigEnv) els.newClientStatsigEnv.dataset.touched = 'true'; }, true);

    async function createClient() {
      try {
        var payload = {
          name: els.newClientName.value.trim(),
          env: els.newClientEnv.value,
          sdk_stack: els.newClientStack.value || 'react_native'
        };
        if (!payload.name) { toast('Name required'); return; }
        if (els.newClientStatsigToggle.checked) {
          payload.statsig_project_name = els.newClientStatsigProject.value.trim() || null;
          payload.statsig_server_secret_env_var = els.newClientStatsigEnv.value.trim() || null;
        }
        var created = await api('/admin/clients', { method: 'POST', body: JSON.stringify(payload) });
        state.lastCreatedSecretKey = created.secret_key || null;
        closeModal('newClientScrim');
        toast('Client created');
        await loadClients();
        selectClient(created.id);
        openSetupDrawer(created.id, true);
      } catch (err) {
        toast(err.message || 'Create failed');
      }
    }

    /* ===================== SETUP DRAWER ===================== */
    async function openSetupDrawer(clientId, justCreated) {
      try {
        var setup = await api('/admin/clients/' + encodeURIComponent(clientId) + '/setup');
        var client = setup;
        els.setupTitle.textContent = (justCreated ? 'Set up ' : 'Setup · ') + client.name;
        var sdkSnippet = setup.setup.sdkSnippet || setup.setup.reactNativeSnippet;
        var sdkInstallTitle = setup.setup.sdkInstallTitle || 'Drop into the React Native app';
        var configCurl = setup.setup.configCurl;
        var statsigEnabled = setup.setup.statsigEnabled === true;
        var secretReveal = '';
        if (justCreated && state.lastCreatedSecretKey) {
          secretReveal =
            '<div class="secret-reveal"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 6h9v6h-9z M4 6V4a3 3 0 1 1 6 0v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
              '<div><div><b>Workspace secret (shown once)</b></div><div class="mono" style="margin-top:4px;">' + escHtml(state.lastCreatedSecretKey) + '</div></div>' +
              '<button class="btn btn-sm" id="copySecretBtn" style="margin-left:auto;">Copy</button>' +
            '</div>';
        }
        var step = 0;
        function next() { step += 1; return String(step); }
        var statsigBlock = '';
        if (statsigEnabled) {
          var envVar = setup.setup.railway.variable;
          var statsigStatusKind = client.statsig_configured ? 'green' : 'warn';
          var statsigStatusLabel = client.statsig_configured ? 'Configured on this server' : 'Missing on this server';
          statsigBlock =
            '<div><div class="card-title" style="margin-bottom:6px;">' + next() + ' · Add this to Railway → Variables</div>' +
              '<div class="card-sub" style="margin-bottom:6px;">' + escHtml(setup.setup.railway.description) + '</div>' +
              '<div class="code" data-copy="' + escAttr(envVar + '=<paste Statsig server secret here>') + '"><button class="copy-btn" data-copy-target>Copy</button>' + escHtml(envVar) + '=<paste Statsig server secret here></div>' +
              '<div style="margin-top:6px;"><span class="tag ' + statsigStatusKind + '">' + escHtml(statsigStatusLabel) + '</span>' +
                (client.statsig_project_name ? ' <span class="tag purple">' + escHtml(client.statsig_project_name) + '</span>' : '') +
              '</div></div>';
        } else {
          statsigBlock =
            '<div><div class="card-title" style="margin-bottom:6px;">Statsig <span class="tag gray" style="margin-left:6px;">Off</span></div>' +
              '<div class="hint">Statsig is not connected for this client. The SDK will still serve placements using the <b>default spec</b>. To run experiments, enable Statsig from <span class="mono">PATCH /admin/clients/' + escHtml(client.id) + '</span> or recreate the client with the Statsig toggle on.</div>' +
            '</div>';
        }
        els.setupBody.innerHTML =
          (secretReveal ? secretReveal : '') +
          '<div><div class="card-title" style="margin-bottom:6px;">' + next() + ' · Public key (SDK install token)</div>' +
            '<div class="code" data-copy="' + escAttr(client.public_key) + '"><button class="copy-btn" data-copy-target>Copy</button>' + escHtml(client.public_key) + '</div></div>' +
          statsigBlock +
          '<div><div class="card-title" style="margin-bottom:6px;">' + next() + ' · ' + escHtml(sdkInstallTitle) + '</div>' +
            '<div class="code" data-copy="' + escAttr(sdkSnippet) + '"><button class="copy-btn" data-copy-target>Copy</button>' + escHtml(sdkSnippet) + '</div></div>' +
          '<div><div class="card-title" style="margin-bottom:6px;">' + next() + ' · Verify with curl</div>' +
            '<div class="code" data-copy="' + escAttr(configCurl) + '"><button class="copy-btn" data-copy-target>Copy</button>' + escHtml(configCurl) + '</div></div>' +
          (statsigEnabled
            ? '<div><div class="card-title" style="margin-bottom:6px;">' + next() + ' · Statsig experiments</div>' +
              '<div class="hint"><b>How variants work.</b> Create an experiment in Statsig (any name you choose). It must expose a string parameter called <span class="mono">' + escHtml(setup.setup.statsigSetup.expectedParameter) + '</span>. The values you ship in that parameter (e.g. <span class="mono">control</span>, <span class="mono">test_1</span>, <span class="mono">test_2</span>) must match the <span class="mono">variant_key</span> values you create in the Slots tab. The server reads <span class="mono">variant_id</span> for the user and serves the matching spec.</div></div>'
            : '');

        Array.prototype.forEach.call(els.setupBody.querySelectorAll('[data-copy-target]'), function(btn) {
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var parent = btn.closest('[data-copy]');
            if (parent) copyText(parent.getAttribute('data-copy'));
          });
        });
        var copySecretBtn = document.getElementById('copySecretBtn');
        if (copySecretBtn && state.lastCreatedSecretKey) copySecretBtn.addEventListener('click', function() { copyText(state.lastCreatedSecretKey); });

        openModal('setupScrim');
      } catch (err) {
        toast(err.message || 'Setup load failed');
      }
    }

    /* ===================== PAYWALLS / PLACEMENTS DATA ===================== */
    async function loadClientData() {
      var client = activeClient();
      if (!client) return;
      try {
        var publicKey = encodeURIComponent(client.public_key);
        var results = await Promise.all([
          api('/admin/specs?public_key=' + publicKey),
          api('/admin/placements'),
        ]);
        state.specs = results[0] || [];
        state.placements = (results[1] || []).filter(function(p) { return p.public_key === client.public_key; });
        if (state.page === 'paywalls') renderPaywalls();
        if (state.page === 'placements') renderPlacements();
      } catch (err) {
        toast(err.message || 'Load failed');
      }
    }

    async function loadEvents() {
      try {
        state.events = await api('/admin/events/recent?limit=50');
        renderEvents();
      } catch (err) {
        toast(err.message || 'Events failed');
      }
    }

    /* ===================== PAYWALLS ===================== */
    function renderPaywalls() {
      renderSpecList();
      renderSpecSelector();
      loadSelectedSpec();
    }
    function renderSpecSelector() {
      var selected = els.editSpec.value;
      els.editSpec.innerHTML = state.specs.map(function(spec) {
        return '<option value="' + escAttr(spec.id) + '">' + escHtml(spec.name) + '</option>';
      }).join('');
      if (state.specs.some(function(s) { return s.id === selected; })) els.editSpec.value = selected;
    }
    function renderSpecList() {
      els.specCount.textContent = String(state.specs.length);
      if (!state.specs.length) {
        els.specs.innerHTML = '<div class="empty">No specs yet for this client.</div>';
        return;
      }
      els.specs.innerHTML = state.specs.map(function(spec) {
        var title = spec.spec && spec.spec.header ? spec.spec.header.title : (spec.spec && spec.spec.headline);
        var cta = spec.spec ? (typeof spec.spec.cta === 'string' ? spec.spec.cta : (spec.spec.cta && spec.spec.cta.text)) : '';
        var statusTag = spec.status === 'active' ? 'green' : (spec.status === 'archived' ? 'warn' : 'gray');
        var active = els.editSpec.value === spec.id ? ' active' : '';
        return '<button type="button" class="table-row' + active + '" data-spec="' + escAttr(spec.id) + '">' +
          '<span class="avatar lib">' + escHtml(initials(spec.name)) + '</span>' +
          '<span><span class="row-title">' + escHtml(spec.name) + '</span><span class="row-meta">' + escHtml(title || 'Untitled') + ' · ' + escHtml(cta || 'no CTA') + '</span></span>' +
          '<span class="tag gray">' + escHtml(spec.spec && (spec.spec.templateId || spec.spec.renderer) || '—') + '</span>' +
          '<span class="tag ' + statusTag + '">' + escHtml(spec.status) + '</span>' +
        '</button>';
      }).join('');
      Array.prototype.forEach.call(els.specs.querySelectorAll('[data-spec]'), function(node) {
        node.addEventListener('click', function() {
          els.editSpec.value = node.getAttribute('data-spec');
          loadSelectedSpec();
        });
      });
    }
    function findSpec(id) { return state.specs.find(function(spec) { return spec.id === id; }); }

    function loadSelectedSpec() {
      var spec = findSpec(els.editSpec.value) || state.specs[0];
      if (!spec) { els.editJson.value = ''; renderPreviewFromEditor(); return; }
      els.editSpec.value = spec.id;
      els.editJson.value = JSON.stringify(spec.spec, null, 2);
      hydrateFields(spec.spec);
      renderPreviewFromEditor();
      renderSpecList();
      els.editorKind.textContent = (spec.spec && (spec.spec.templateId || spec.spec.renderer)) || 'spec';
    }
    function hydrateFields(spec) {
      var product = (spec.products || [])[0] || {};
      var features = spec.features || [];
      var style = spec.style || {};
      var metadata = product.metadata || {};
      els.fieldTitle.value = (spec.header && spec.header.title) || spec.headline || '';
      els.fieldSubtitle.value = (spec.header && spec.header.subtitle) || spec.subheadline || '';
      els.fieldCta.value = typeof spec.cta === 'string' ? spec.cta : (spec.cta && spec.cta.text) || '';
      els.fieldPresentation.value = (spec.presentation && spec.presentation.mode) || 'sheet';
      els.fieldLegal.value = spec.legal || '';
      els.fieldProductName.value = product.name || '';
      els.fieldProductPrice.value = typeof product.price === 'string' ? product.price : (product.price ? JSON.stringify(product.price) : '');
      els.fieldOriginalPrice.value = product.originalPrice || '';
      els.fieldBadge.value = product.badge || '';
      els.fieldMonthly.value = metadata.monthly || product.description || '';
      els.fieldSocialProof.value = spec.social_proof ? spec.social_proof.text : '';
      for (var i=0;i<4;i++) {
        var feature = features[i];
        els['fieldFeature' + (i+1)].value = typeof feature === 'string' ? feature : (feature && feature.text) || '';
      }
      els.fieldTestimonialName.value = metadata.testimonialName || '';
      els.fieldTestimonialFollowers.value = metadata.testimonialFollowers || '';
      els.fieldTestimonialText.value = metadata.testimonialText || '';
      els.fieldAccentColor.value = style.accentColor || '';
      els.fieldBackgroundColor.value = style.backgroundColor || '';
      els.fieldTextColor.value = style.textColor || '';
    }
    function syncFieldsIntoJson(throwOnError) {
      try {
        var spec = JSON.parse(els.editJson.value);
        if (!spec.header) spec.header = {};
        spec.header.title = els.fieldTitle.value;
        spec.header.subtitle = els.fieldSubtitle.value;
        spec.cta = typeof spec.cta === 'string' ? els.fieldCta.value : Object.assign({}, spec.cta || {}, { text: els.fieldCta.value });
        spec.presentation = { mode: els.fieldPresentation.value || 'sheet' };
        spec.legal = els.fieldLegal.value;
        spec.social_proof = Object.assign({}, spec.social_proof || {}, { text: els.fieldSocialProof.value });
        spec.style = Object.assign({}, spec.style || {});
        if (els.fieldAccentColor.value) spec.style.accentColor = els.fieldAccentColor.value;
        if (els.fieldBackgroundColor.value) spec.style.backgroundColor = els.fieldBackgroundColor.value;
        if (els.fieldTextColor.value) spec.style.textColor = els.fieldTextColor.value;
        spec.products = spec.products && spec.products.length ? spec.products : [{}];
        var product = spec.products[0];
        product.id = product.id || 'product';
        product.name = els.fieldProductName.value;
        product.price = els.fieldProductPrice.value;
        product.originalPrice = els.fieldOriginalPrice.value || undefined;
        product.badge = els.fieldBadge.value || undefined;
        product.description = els.fieldMonthly.value || product.description;
        product.metadata = Object.assign({}, product.metadata || {}, {
          monthly: els.fieldMonthly.value,
          testimonialName: els.fieldTestimonialName.value,
          testimonialFollowers: els.fieldTestimonialFollowers.value,
          testimonialText: els.fieldTestimonialText.value
        });
        spec.features = [1,2,3,4].map(function(index) {
          return { text: els['fieldFeature' + index].value, included: true };
        }).filter(function(feature) { return feature.text.trim(); });
        rebuildWebViewDocument(spec);
        els.editJson.value = JSON.stringify(spec, null, 2);
        return spec;
      } catch (err) {
        if (throwOnError) throw err;
        return null;
      }
    }
    async function saveSelectedSpec() {
      try {
        var spec = findSpec(els.editSpec.value);
        if (!spec) throw new Error('Pick a spec first');
        var json = syncFieldsIntoJson(true);
        await api('/admin/specs/' + encodeURIComponent(spec.id), { method:'PUT', body: JSON.stringify({ name: spec.name, spec: json }) });
        await loadClientData();
        toast('Saved · refresh Expo Go to see the change');
      } catch (err) {
        toast(err.message || 'Save failed');
      }
    }
    function renderPreviewFromEditor() {
      var spec = syncFieldsIntoJson(false);
      if (!spec) { els.specPreview.innerHTML = '<div class="empty">No spec selected.</div>'; return; }
      els.specPreview.innerHTML = '<iframe class="preview-frame" sandbox="allow-scripts" srcdoc="' + escAttr(composePreviewDocument(spec)) + '"></iframe>';
    }

    function rebuildWebViewDocument(spec) {
      spec.renderer = 'webview';
      spec.templateId = spec.templateId || 'influish_free_trial';
      spec.revision = String(Date.now());
      spec.cacheKey = (spec.templateId || 'paywall') + ':' + spec.revision;
      spec.dismiss = spec.dismiss || { enabled: true, delay_ms: 0 };
      spec.bridge = spec.bridge || { version: 1, allowedActions: ['cta','dismiss','open_url','custom_action'] };
      spec.document = {
        html: buildWebViewHtml(spec),
        css: buildWebViewCss(spec),
        js: spec.document && spec.document.js,
        baseUrl: spec.document && spec.document.baseUrl
      };
    }

    function buildWebViewHtml(spec) {
      var product = (spec.products || [])[0] || {};
      var features = spec.features || [];
      var title = (spec.header && spec.header.title) || spec.headline || '';
      var subtitle = (spec.header && spec.header.subtitle) || spec.subheadline || '';
      var cta = typeof spec.cta === 'string' ? spec.cta : (spec.cta && spec.cta.text) || '';
      var social = spec.social_proof && spec.social_proof.text;
      var template = spec.templateId || 'influish_free_trial';
      if (template === 'influish_intro_offer') {
        var introPriceLabel = escHtml(product.name || '').replace(/(₹[0-9,]+)/, '<span>$1</span>');
        var introFeatures = features.map(function(feature, index) {
          var text = typeof feature === 'string' ? feature : feature.text;
          return '<li><span class="icon">' + ['•••','▣','✦','◆'][index % 4] + '</span><span>' + escHtml(text || '') + '</span><b>›</b></li>';
        }).join('');
        return '<main class="tz-paywall ' + escAttr(template) + '">' +
          '<button class="tz-close tz-close-right" data-tranzmit-action="dismiss" aria-label="Close">×</button>' +
          '<section class="brand intro-brand"><span class="mark">In</span><strong>Influish</strong><em>PRO</em></section>' +
          '<h1>Unlock More Collabs.<br><span>Earn More.</span></h1>' +
          '<p class="subtitle">' + escHtml(subtitle) + '</p>' +
          '<section class="offer intro-offer">' +
            (product.badge ? '<div class="badge">✦ ' + escHtml(product.badge) + ' ✦</div>' : '') +
            '<div class="price-row intro-price"><strong>' + introPriceLabel + '</strong></div>' +
            '<p class="price-sub">' + escHtml(product.price || '') + '</p><div class="offer-divider"></div>' +
            (product.description ? '<p class="monthly"><span>₹</span>' + escHtml(String(product.description).replace(/^Just\\s*/i, '')) + '</p>' : '') +
          '</section>' +
          '<section class="creator-proof"><div class="avatars"><span></span><span></span><span></span><b>99+</b></div><p>Trusted by <strong>8,20,737+</strong> creators<br><strong>₹2.3 Cr+</strong> paid out this year</p></section>' +
          '<section class="feature-panel"><h2>Why creators upgrade</h2><ul class="features">' + introFeatures + '</ul></section>' +
          '<section class="testimonial intro-testimonial"><span class="avatar avatar-ananya"></span><div><strong>' + escHtml((product.metadata && product.metadata.testimonialName) || 'Ananya') + ' <small>· ' + escHtml((product.metadata && product.metadata.testimonialFollowers) || '31K followers') + '</small></strong><p>★★★★★</p><em>' + escHtml((product.metadata && product.metadata.testimonialText) || '') + '</em></div></section>' +
          '<section class="legal-row"><span>▣ No hidden charges</span><span>↻ Cancel anytime</span><span>◇ Secure checkout</span></section>' +
          '<button class="cta" data-tranzmit-action="cta" data-product-id="' + escAttr(product.id || 'product') + '">' + escHtml(cta || 'Continue with Pro') + ' <span>✦</span></button>' +
        '</main>';
      }
      if (template === 'influish_annual_pro') {
        var annualFeatures = features.map(function(feature, index) {
          var text = typeof feature === 'string' ? feature : feature.text;
          var parts = String(text || '').split('|');
          return '<li><span class="icon">' + ['•••','▣','✦'][index % 3] + '</span><strong>' + escHtml(parts[0] || '') + '</strong>' + (parts[1] ? '<small>' + escHtml(parts[1]) + '</small>' : '') + '</li>';
        }).join('');
        return '<main class="tz-paywall ' + escAttr(template) + '">' +
          '<button class="tz-close" data-tranzmit-action="dismiss" aria-label="Close">×</button>' +
          '<section class="brand"><span class="mark">In</span><strong>Influish</strong></section>' +
          '<h1>Start <span>Earning</span> with Pro</h1>' +
          '<p class="subtitle">' + escHtml(subtitle) + '</p>' +
          '<section class="stats-row"><article><b>8,20,737+</b><small>creators trust Influish</small></article><article><b>42,000+</b><small>creators earning with Pro</small></article></section>' +
          '<section class="offer annual-offer">' +
            (product.badge ? '<div class="badge">★ ' + escHtml(product.badge) + '</div>' : '') +
            '<div class="price-row annual-price"><strong>' + escHtml(product.name || '') + '</strong><span>' + escHtml(product.price || '') + '</span></div>' +
            (product.description ? '<p class="monthly">' + escHtml(product.description) + '</p>' : '') +
            (product.originalPrice ? '<p class="original">' + escHtml(product.originalPrice) + '</p>' : '') +
          '</section>' +
          '<ul class="features">' + annualFeatures + '</ul>' +
          '<section class="testimonial annual-testimonial"><span class="avatar avatar-riya"></span><div><strong>' + escHtml((product.metadata && product.metadata.testimonialName) || 'Riya') + ' <small>· ' + escHtml((product.metadata && product.metadata.testimonialFollowers) || '58K followers') + '</small></strong><p>“ ' + escHtml((product.metadata && product.metadata.testimonialText) || '') + ' ”</p></div></section>' +
          '<section class="legal-row"><span>▣ Secure payments</span><span>◖ Creator support</span><span>↻ Cancel anytime</span></section>' +
          '<button class="cta" data-tranzmit-action="cta" data-product-id="' + escAttr(product.id || 'product') + '">' + escHtml(cta || 'Continue') + '</button>' +
          '<p class="guarantee">♡ 7-day money-back guarantee</p>' +
        '</main>';
      }
      var featureHtml = features.map(function(feature, index) {
        var text = typeof feature === 'string' ? feature : feature.text;
        return '<li><span class="icon">' + ['💬','💼','🪄','🛡'][index % 4] + '</span><span>' + escHtml(text || '') + '</span></li>';
      }).join('');
      return '<main class="tz-paywall ' + escAttr(template) + '">' +
        '<button class="tz-close" data-tranzmit-action="dismiss" aria-label="Close">×</button>' +
        '<section class="brand"><span class="mark">In</span><strong>Influish</strong></section>' +
        '<h1>' + escHtml(title) + '</h1>' +
        '<p class="subtitle">' + escHtml(subtitle) + '</p>' +
        (social ? '<div class="social">' + escHtml(social) + '</div>' : '') +
        '<section class="offer">' +
          (product.badge ? '<div class="badge">' + escHtml(product.badge) + '</div>' : '') +
          '<div class="price-row"><strong>' + escHtml(product.name || '') + '</strong><span>' + escHtml(product.price || '') + '</span></div>' +
          (product.description ? '<p class="monthly">' + escHtml(product.description) + '</p>' : '') +
          (product.originalPrice ? '<p class="original">' + escHtml(product.originalPrice) + '</p>' : '') +
        '</section>' +
        '<ul class="features">' + featureHtml + '</ul>' +
        '<section class="testimonial"><strong>' + escHtml((product.metadata && product.metadata.testimonialName) || 'Riya') + '</strong><span> · ' + escHtml((product.metadata && product.metadata.testimonialFollowers) || '58K followers') + '</span><p>' + escHtml((product.metadata && product.metadata.testimonialText) || '') + '</p></section>' +
        '<button class="cta" data-tranzmit-action="cta" data-product-id="' + escAttr(product.id || 'product') + '">' + escHtml(cta || 'Continue') + '</button>' +
        (spec.legal ? '<p class="legal">' + escHtml(spec.legal) + '</p>' : '') +
      '</main>';
    }

    function buildWebViewCss(spec) {
      var style = spec.style || {};
      var accent = style.accentColor || '#6537d9';
      var bg = style.backgroundColor || '#fbfaff';
      var text = style.textColor || '#17172e';
      return 'html,body{margin:0;min-height:100%;background:transparent;overflow-x:hidden}' +
        'body{font-family:-apple-system,BlinkMacSystemFont,\"Inter\",\"Segoe UI\",sans-serif;background:transparent;color:' + text + ';}' +
        '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}' +
        '.tz-paywall{min-height:var(--tz-vh,100svh);background:' + bg + ';padding:clamp(14px,4vw,22px);padding-bottom:calc(clamp(92px,24vw,112px) + var(--tz-safe-bottom,env(safe-area-inset-bottom)));border-radius:clamp(20px,7vw,28px);text-align:center;position:relative;overflow-x:hidden;overflow-y:auto;display:flex;flex-direction:column;gap:clamp(8px,1.8vh,14px)}' +
        '.tz-close{position:absolute;left:clamp(10px,3vw,16px);top:clamp(10px,3vw,16px);border:0;background:#fff;border-radius:999px;width:clamp(34px,9vw,38px);height:clamp(34px,9vw,38px);font-size:clamp(22px,7vw,28px);color:#6f6878;z-index:2}' +
        '.brand{display:flex;justify-content:center;align-items:center;gap:8px;font-size:clamp(18px,5vw,24px);margin:clamp(4px,1vh,8px) 0 clamp(8px,2vh,16px)}.mark{background:' + accent + ';color:#fff;padding:4px 6px;font-weight:900}' +
        'h1{font-size:clamp(28px,9vw,38px);line-height:1.05;margin:0 clamp(10px,3vw,18px) 8px;font-weight:900;letter-spacing:-.04em;text-wrap:balance}.subtitle{color:#6f6878;font-size:clamp(14px,4vw,16px);line-height:1.4;margin:0 auto 10px;max-width:340px}' +
        '.social{display:inline-block;background:#fff;border:1px solid #e8e1f6;border-radius:999px;padding:8px 12px;margin-bottom:8px;font-weight:800;font-size:clamp(12px,3.5vw,14px)}' +
        '.offer{background:#fff;border:1.5px solid ' + accent + ';border-radius:clamp(18px,6vw,24px);padding:clamp(16px,5vw,28px) clamp(12px,4vw,18px) clamp(14px,4vw,20px);margin:clamp(8px,2vh,14px) 0 8px;box-shadow:0 12px 28px rgba(101,55,217,.12);position:relative}.badge{position:absolute;left:50%;top:-14px;transform:translateX(-50%);background:#e6b246;color:#fff;border-radius:8px;padding:6px 14px;font-weight:900;font-size:12px;white-space:nowrap}.price-row{display:flex;align-items:flex-end;justify-content:center;gap:8px;flex-wrap:wrap}.price-row strong{color:' + accent + ';font-size:clamp(38px,13vw,56px);line-height:1;font-weight:900}.price-row span{font-size:clamp(16px,5vw,22px);font-weight:800}.monthly{color:' + accent + ';font-weight:900;font-size:clamp(14px,4.5vw,18px);margin:6px 0 0}.original{text-decoration:line-through;color:#8b8492;margin:4px 0 0;font-size:13px}' +
        '.features{display:grid;grid-template-columns:1fr;gap:8px;list-style:none;padding:0;margin:0 0 8px}.features li{display:flex;align-items:center;gap:10px;background:#fff;border-radius:14px;padding:clamp(10px,3vw,12px);text-align:left;font-weight:700;font-size:clamp(13px,3.8vw,15px);line-height:1.25}.icon{background:#f5f1ff;color:' + accent + ';border-radius:10px;min-width:32px;width:32px;height:32px;display:grid;place-items:center}' +
        '.testimonial{background:#fff;border:1px solid #eeeaf4;border-radius:18px;padding:12px;margin-bottom:8px;text-align:left;font-size:clamp(13px,3.7vw,15px)}.testimonial p{margin:6px 0 0;color:#3a3347;line-height:1.3}.cta{border:0;border-radius:999px;background:' + accent + ';color:#fff;min-height:clamp(52px,13vw,58px);font-size:clamp(17px,4.8vw,20px);font-weight:900;box-shadow:0 12px 24px rgba(101,55,217,.22);position:fixed;left:calc(var(--tz-safe-left,0px) + clamp(14px,4vw,22px));right:calc(var(--tz-safe-right,0px) + clamp(14px,4vw,22px));bottom:calc(var(--tz-safe-bottom,0px) + clamp(14px,4vw,22px));z-index:3}.legal{color:#736d7c;font-size:12px;margin:4px 0 0;line-height:1.35}' +
        '.influish_annual_pro .features{grid-template-columns:repeat(auto-fit,minmax(88px,1fr))}.influish_annual_pro .features li{display:block;text-align:center;font-size:13px}.influish_intro_offer .offer{margin-top:22px}' +
        '.influish_intro_offer,.influish_annual_pro{background:radial-gradient(circle at 50% 38%,rgba(118,59,232,.13),transparent 34%),linear-gradient(180deg,#fff 0%,#fbf8ff 100%);gap:clamp(10px,1.8vh,16px);padding:clamp(18px,4.8vw,28px) clamp(18px,5.2vw,30px);padding-bottom:calc(clamp(84px,22vw,98px) + var(--tz-safe-bottom,env(safe-area-inset-bottom)));display:flex;flex-direction:column}.influish_intro_offer{gap:clamp(6px,1vh,10px)}.influish_intro_offer .subtitle{margin-top:4px}.tz-close-right{left:auto;right:clamp(16px,4vw,24px);background:transparent;box-shadow:none;color:#7d7784;font-size:36px}.brand .mark{width:34px;height:38px;display:grid;place-items:center;background:' + accent + ';color:#fff;font-family:Georgia,serif;font-weight:900;font-size:24px;clip-path:polygon(0 0,100% 0,100% 100%,50% 78%,0 100%)}.brand em{background:' + accent + ';color:#fff;border-radius:999px;padding:2px 8px;font-size:12px;font-style:normal}.influish_intro_offer h1{font-size:clamp(32px,9.55vw,42px);line-height:1.04;margin:0;font-weight:950;letter-spacing:-.055em}.influish_annual_pro h1{font-size:clamp(36px,10.8vw,50px);line-height:1.04;margin:0;font-weight:950;letter-spacing:-.055em}.influish_intro_offer h1 span,.influish_annual_pro h1 span{color:' + accent + '}' +
        '.intro-offer{margin:clamp(7px,1.2vh,11px) 28px 0!important;padding:22px 16px 12px!important;border-color:#eee7fb!important;border-radius:26px!important}.intro-offer:before,.intro-offer:after{content:"";position:absolute;top:-18px;width:28px;height:24px;background:#c88d25;z-index:-1}.intro-offer:before{left:74px;transform:skewX(-25deg)}.intro-offer:after{right:74px;transform:skewX(25deg)}.intro-price{display:block!important}.intro-price strong{font-size:clamp(29px,8.4vw,39px)!important;letter-spacing:-.03em;color:#19162b!important}.intro-price strong span{color:' + accent + ';font-size:1.48em}.price-sub{color:#7b7482;margin:5px 0 0;font-size:16px}.offer-divider{height:1px;background:#eeeaf4;margin:8px 20px 6px}.intro-offer .monthly{display:inline-flex;align-items:center;gap:6px;background:#f6f1ff;border-radius:999px;padding:5px 16px;font-size:14px}.intro-offer .monthly span{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:' + accent + ';color:#fff}' +
        '.creator-proof{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:2px}.avatars{display:flex;align-items:center}.avatars span,.avatars b{width:31px;height:31px;border-radius:50%;margin-left:-7px;border:2px solid #fff;background:linear-gradient(135deg,#29162c,#f2c4aa)}.avatars span:first-child{margin-left:0}.avatars span:nth-child(2){background:linear-gradient(135deg,#141a2f,#d7c7bb)}.avatars span:nth-child(3){background:linear-gradient(135deg,#2f2316,#f1d6b0)}.avatars b{display:grid;place-items:center;background:' + accent + ';color:#fff;font-size:11px}.creator-proof p{margin:0;text-align:left;color:#5e5867;line-height:1.18;font-size:13px}.creator-proof strong{color:' + accent + ';font-size:18px}' +
        '.feature-panel{background:#fff;border-radius:20px;padding:12px 14px 11px;text-align:left;box-shadow:0 14px 34px rgba(35,28,56,.06)}.feature-panel h2{font-size:17px;margin:0 0 7px}.feature-panel .features{display:grid;gap:0;border:1px solid #eeeaf4;border-radius:14px;overflow:hidden}.feature-panel li{display:grid;grid-template-columns:28px 1fr 10px;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid #eeeaf4;font-size:12px;line-height:1.12}.feature-panel li:last-child{border-bottom:0}.feature-panel .icon{width:24px;height:24px;border-radius:7px}.feature-panel b{font-size:20px;color:' + accent + ';font-weight:400}.avatar{display:block;background:linear-gradient(135deg,#24162f,#f2d3c6);border-radius:50%;box-shadow:0 0 0 3px #fff}.intro-testimonial{display:flex;align-items:center;gap:12px;border-radius:18px;padding:12px;text-align:left}.intro-testimonial .avatar{width:58px;height:58px}.intro-testimonial small{font-weight:500;color:#7b7482}.intro-testimonial p{color:#e4b23e;letter-spacing:2px;margin:4px 0 2px}.intro-testimonial em{font-style:normal}.legal-row{display:flex;align-items:center;justify-content:space-around;gap:6px;color:#6f6878;font-size:12px;background:rgba(255,255,255,.84);border:1px solid #eeeaf4;border-radius:999px;padding:9px 12px}' +
        '.influish_annual_pro{padding-left:clamp(20px,7vw,48px);padding-right:clamp(20px,7vw,48px)}.stats-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.stats-row article{background:#fff;border-radius:12px;padding:12px 10px;display:grid;gap:4px;box-shadow:0 12px 28px rgba(35,28,56,.06)}.stats-row b{color:' + accent + ';font-size:19px}.stats-row small{font-size:12px;color:#6f6878}.annual-offer{margin-top:6px!important;padding:34px 18px 24px!important}.annual-price{display:flex!important;align-items:flex-end;justify-content:center;gap:8px}.annual-price strong{font-size:clamp(72px,20vw,95px)!important;line-height:.86}.annual-price span{font-size:22px;font-weight:900}.annual-offer .monthly{font-size:22px}.annual-offer .original{font-size:18px}.influish_annual_pro .features{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.influish_annual_pro .features li{background:#fff;border-radius:14px;box-shadow:0 12px 28px rgba(35,28,56,.06);padding:16px 9px;display:grid;gap:7px;text-align:center;min-height:170px;align-content:start}.influish_annual_pro .features .icon{width:42px;height:42px;border-radius:14px;margin:0 auto}.influish_annual_pro .features strong{font-size:19px;line-height:1.07;letter-spacing:-.02em}.influish_annual_pro .features small{font-size:12px;color:#8b8492;line-height:1.28}' +
        '.annual-testimonial{display:flex;align-items:center;gap:14px;border-radius:20px;padding:13px 18px;text-align:left;position:relative;overflow:hidden}.annual-testimonial:after{content:"”";position:absolute;right:20px;top:-12px;color:#f2eaff;font-size:112px;font-weight:900}.annual-testimonial .avatar{width:64px;height:64px}.annual-testimonial small{font-weight:500;color:#7b7482}.annual-testimonial p{font-style:italic;color:#332b44;margin:6px 0 0;line-height:1.34}.guarantee{position:fixed;left:0;right:0;bottom:calc(4px + var(--tz-safe-bottom,env(safe-area-inset-bottom)));margin:0;color:#8b8492;font-size:12px;text-align:center;z-index:3}' +
        '.tz-presentation-fullscreen .tz-paywall{width:var(--tz-vw,100vw)!important;min-height:var(--tz-vh,100svh)!important;margin:0!important;border-radius:0!important;box-shadow:none!important}.tz-presentation-fullscreen .tz-close,.tz-presentation-fullscreen .close{display:none!important}.tz-presentation-sheet .tz-paywall,.tz-presentation-modal .tz-paywall{border-radius:clamp(20px,7vw,28px)}' +
        '@media (max-width:360px){.intro-offer{margin-left:8px!important;margin-right:8px!important}.annual-price strong{font-size:64px!important}}@media (min-width:390px) and (min-height:844px){.influish_intro_offer{gap:10px}.intro-offer{margin-left:28px!important;margin-right:28px!important}}@media (min-width:412px) and (min-height:900px){.influish_intro_offer h1{font-size:44px}.intro-offer{padding-top:26px!important;padding-bottom:16px!important}}@media (min-width:700px){.tz-paywall{max-width:520px;margin:0 auto}.tz-presentation-fullscreen .tz-paywall{max-width:none}}@media (max-height:680px){.brand{display:none}.testimonial{display:none}.tz-paywall{gap:7px}.features{gap:6px}}';
    }

    function composePreviewDocument(spec) {
      var previewVars = ':root{--tz-vw:390px;--tz-vh:844px;--tz-container-width:390px;--tz-container-height:844px;--tz-safe-top:0px;--tz-safe-bottom:0px;--tz-safe-left:0px;--tz-safe-right:0px;--tz-scale:1;}';
      return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + previewVars + (spec.document && spec.document.css || '') + '</style></head><body>' + (spec.document && spec.document.html || '') + '</body></html>';
    }

    /* ===================== PLACEMENTS ===================== */
    function renderPlacements() {
      if (!state.placements.length) {
        els.placementsList.innerHTML = '<div class="hint">No placements yet. Create one via <span class="mono">POST /admin/placements</span> with a trigger like <span class="mono">upgrade_pro</span>.</div>';
        return;
      }
      els.placementsList.innerHTML = state.placements.map(function(p) {
        var defaultSpec = findSpec(p.default_spec_id);
        var variants = Array.isArray(p.variants) ? p.variants : [];
        var experimentId = p.statsig_experiment_id || p.experiment_id || '';
        var variantsHtml = variants.length
          ? variants.map(function(v) {
              var spec = findSpec(v.spec_id);
              var isDefault = (v.variant_key || v.variant_id) === p.variant_id;
              return '<div class="variant" data-variant-key="' + escAttr(v.variant_key || v.variant_id) + '" data-placement="' + escAttr(p.id) + '">' +
                '<span class="variant-key">' + escHtml(v.variant_key || v.variant_id) + (isDefault ? ' ★' : '') + '</span>' +
                '<select class="variant-spec">' + state.specs.map(function(s) {
                  return '<option value="' + escAttr(s.id) + '"' + (s.id === v.spec_id ? ' selected' : '') + '>' + escHtml(s.name) + '</option>';
                }).join('') + '</select>' +
                '<input type="number" min="0" max="100" class="weight-input variant-weight" value="' + escAttr(String(v.weight != null ? v.weight : 50)) + '">' +
                '<button class="btn btn-sm variant-save">Save</button>' +
                '<button class="btn btn-sm btn-danger variant-delete">×</button>' +
              '</div>';
            }).join('')
          : '<div class="empty" style="padding:6px 0;">No variants yet — the placement always serves the default spec.</div>';

        return '<section class="card">' +
          '<div class="card-head">' +
            '<div><div class="card-title">' + escHtml(p.trigger) + '</div><div class="card-sub mono">' + escHtml(p.id) + '</div></div>' +
            '<div class="row">' +
              '<span class="tag ' + (p.status === 'active' || p.enabled ? 'green' : 'warn') + '">' + escHtml(p.status || (p.enabled ? 'active' : 'paused')) + '</span>' +
              '<button class="btn btn-sm" data-placement-toggle="' + escAttr(p.id) + '">' + (p.status === 'active' || p.enabled ? 'Pause' : 'Activate') + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="card-body stack">' +
            '<div class="grid-2">' +
              '<div class="field"><span class="field-label">Default spec</span><select data-default-spec="' + escAttr(p.id) + '">' + state.specs.map(function(s) {
                return '<option value="' + escAttr(s.id) + '"' + (s.id === p.default_spec_id ? ' selected' : '') + '>' + escHtml(s.name) + '</option>';
              }).join('') + '</select></div>' +
              '<div class="field"><span class="field-label">Statsig experiment ID</span><input data-experiment="' + escAttr(p.id) + '" value="' + escAttr(experimentId) + '" placeholder="e.g. paywall_intro_vs_trial"></div>' +
            '</div>' +
            '<div class="row" style="justify-content:flex-end;"><button class="btn btn-accent btn-sm" data-save-placement="' + escAttr(p.id) + '">Save placement</button></div>' +
            '<div class="card-sub" style="margin-top:4px;border-top:1px solid var(--line);padding-top:10px;"><b>Variants</b> — keys must match the <span class="mono">variant_id</span> values returned by the Statsig experiment.</div>' +
            variantsHtml +
            '<div class="row" style="gap:6px;margin-top:6px;">' +
              '<input class="weight-input" style="width:auto;flex:1;" placeholder="variant_key (e.g. test_1)" data-new-variant-key="' + escAttr(p.id) + '">' +
              '<select data-new-variant-spec="' + escAttr(p.id) + '">' + state.specs.map(function(s) {
                return '<option value="' + escAttr(s.id) + '">' + escHtml(s.name) + '</option>';
              }).join('') + '</select>' +
              '<input type="number" class="weight-input" min="0" max="100" value="50" data-new-variant-weight="' + escAttr(p.id) + '">' +
              '<button class="btn btn-sm" data-add-variant="' + escAttr(p.id) + '">+ Add variant</button>' +
            '</div>' +
          '</div>' +
        '</section>';
      }).join('');

      // Wire up actions
      Array.prototype.forEach.call(els.placementsList.querySelectorAll('[data-save-placement]'), function(btn) {
        btn.addEventListener('click', function() { savePlacement(btn.getAttribute('data-save-placement')); });
      });
      Array.prototype.forEach.call(els.placementsList.querySelectorAll('[data-placement-toggle]'), function(btn) {
        btn.addEventListener('click', function() { togglePlacement(btn.getAttribute('data-placement-toggle')); });
      });
      Array.prototype.forEach.call(els.placementsList.querySelectorAll('[data-add-variant]'), function(btn) {
        btn.addEventListener('click', function() { addVariant(btn.getAttribute('data-add-variant')); });
      });
      Array.prototype.forEach.call(els.placementsList.querySelectorAll('.variant'), function(row) {
        var placementId = row.getAttribute('data-placement');
        var variantKey = row.getAttribute('data-variant-key');
        var saveBtn = row.querySelector('.variant-save');
        var delBtn = row.querySelector('.variant-delete');
        if (saveBtn) saveBtn.addEventListener('click', function() { saveVariant(placementId, variantKey, row); });
        if (delBtn) delBtn.addEventListener('click', function() { deleteVariant(placementId, variantKey); });
      });
    }

    async function savePlacement(id) {
      try {
        var defaultSpecSelect = els.placementsList.querySelector('[data-default-spec="' + cssEscape(id) + '"]');
        var experimentInput = els.placementsList.querySelector('[data-experiment="' + cssEscape(id) + '"]');
        var payload = {
          default_spec_id: defaultSpecSelect ? defaultSpecSelect.value : null,
          statsig_experiment_id: experimentInput ? experimentInput.value.trim() : null,
        };
        await api('/admin/placements/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payload) });
        await loadClientData();
        toast('Placement saved');
      } catch (err) { toast(err.message || 'Save failed'); }
    }
    async function togglePlacement(id) {
      var placement = state.placements.find(function(p) { return p.id === id; });
      var nextStatus = (placement && placement.status === 'active') ? 'paused' : 'active';
      try {
        await api('/admin/placements/' + encodeURIComponent(id) + '/status', { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) });
        await loadClientData();
        toast('Placement ' + nextStatus);
      } catch (err) { toast(err.message || 'Toggle failed'); }
    }
    async function saveVariant(placementId, variantKey, row) {
      try {
        var specSelect = row.querySelector('.variant-spec');
        var weightInput = row.querySelector('.variant-weight');
        await api('/admin/placements/' + encodeURIComponent(placementId) + '/variants/' + encodeURIComponent(variantKey), {
          method: 'PUT',
          body: JSON.stringify({ spec_id: specSelect.value, weight: Number(weightInput.value) || 50, status: 'active' })
        });
        await loadClientData();
        toast('Variant ' + variantKey + ' saved');
      } catch (err) { toast(err.message || 'Save failed'); }
    }
    async function deleteVariant(placementId, variantKey) {
      if (!confirm('Delete variant ' + variantKey + '?')) return;
      try {
        await api('/admin/placements/' + encodeURIComponent(placementId) + '/variants/' + encodeURIComponent(variantKey), { method: 'DELETE' });
        await loadClientData();
        toast('Variant deleted');
      } catch (err) { toast(err.message || 'Delete failed'); }
    }
    async function addVariant(placementId) {
      try {
        var keyInput = els.placementsList.querySelector('[data-new-variant-key="' + cssEscape(placementId) + '"]');
        var specSelect = els.placementsList.querySelector('[data-new-variant-spec="' + cssEscape(placementId) + '"]');
        var weightInput = els.placementsList.querySelector('[data-new-variant-weight="' + cssEscape(placementId) + '"]');
        if (!keyInput || !specSelect) return;
        var variantKey = keyInput.value.trim();
        if (!variantKey) { toast('Enter a variant key like control or test_1'); return; }
        await api('/admin/placements/' + encodeURIComponent(placementId) + '/variants', {
          method: 'POST',
          body: JSON.stringify({ variant_key: variantKey, spec_id: specSelect.value, weight: Number(weightInput.value) || 50 })
        });
        await loadClientData();
        toast('Variant ' + variantKey + ' added');
      } catch (err) { toast(err.message || 'Add failed'); }
    }
    function cssEscape(s) {
      if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
      return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    }

    async function previewLiveConfig() {
      var client = activeClient();
      if (!client) return;
      try {
        var res = await fetch(base() + '/v1/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            public_key: client.public_key,
            identity: { userId: 'dashboard_preview', identifiers: { stableID: 'dashboard_preview' } },
            userTraits: { source: 'dashboard' }
          })
        });
        var json = await res.json();
        var placements = (json && json.placements) || {};
        var lines = Object.keys(placements).map(function(key) {
          var p = placements[key];
          if (!p) return key + '  →  null';
          var variant = p.variant_key || p.variantId || 'default';
          var layout = p.spec && p.spec.layout || '—';
          var title = (p.spec && p.spec.header && p.spec.header.title) || (p.spec && p.spec.headline) || 'Untitled';
          return key + '  →  ' + variant + ' · ' + layout + ' · ' + title;
        });
        toast(lines.length ? lines.join('\\n') : 'No placements served');
      } catch (err) {
        toast(err.message || 'Preview failed');
      }
    }

    /* ===================== EVENTS ===================== */
    function renderEvents() {
      if (!state.events.length) {
        els.events.innerHTML = '<div class="empty">No events recorded yet.</div>';
        return;
      }
      els.events.innerHTML = state.events.map(function(ev) {
        var time = '';
        try { time = new Date(ev.created_at).toLocaleTimeString(); } catch (_) {}
        var props = ev.properties || {};
        var summary = [
          props.placement_id ? 'placement: ' + props.placement_id : null,
          props.variant_key ? 'variant: ' + props.variant_key : null,
          props.product_id ? 'product: ' + props.product_id : null,
        ].filter(Boolean).join(' · ');
        return '<div class="table-row">' +
          '<span class="avatar ev">' + escHtml((ev.event_name || 'ev').slice(0,2).toUpperCase()) + '</span>' +
          '<span><span class="row-title">' + escHtml(ev.event_name || '—') + '</span><span class="row-meta">' + escHtml(summary || (ev.session_id || '')) + '</span></span>' +
          '<span class="tag gray mono">' + escHtml(ev.public_key) + '</span>' +
          '<span class="tag gray">' + escHtml(time) + '</span>' +
        '</div>';
      }).join('');
    }
  </script>
</body>
</html>`;
