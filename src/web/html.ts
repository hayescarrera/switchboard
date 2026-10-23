/** Tiny HTML helpers. Everything dynamic goes through esc(). No inline scripts (CSP). */

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type Html = { __html: string };
export const raw = (s: string): Html => ({ __html: s });

/** Tagged template: interpolations are escaped unless wrapped in raw() or are arrays of Html. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1]!;
  });
  return raw(out);
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (typeof v === "object" && "__html" in (v as Html)) return (v as Html).__html;
  return esc(v);
}

export function page(opts: { title: string; user?: { name: string } | null; body: Html; narrow?: boolean }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(opts.title)} · Tekhnea</title>
<link rel="stylesheet" href="/assets/style.css">
<script src="/assets/webauthn.js" defer></script>
<script src="/assets/app.js" defer></script>
</head>
<body>
<header class="top">
  <a class="brand" href="/"><span class="dot" aria-hidden="true"></span>Tekhnea</a>
  ${
    opts.user
      ? `<form method="post" action="/auth/sign-out" class="who"><span>${esc(opts.user.name)}</span><button class="link">Sign out</button></form>`
      : ""
  }
</header>
<main class="${opts.narrow ? "narrow" : ""}">
${opts.body.__html}
</main>
</body>
</html>`;
}

/** The passkey sign-in / create-account block. Reloads the page when done. */
export function signInBlock(lead: string): Html {
  return html`
    <section class="card">
      <p class="lead">${lead}</p>
      <button type="button" class="primary" data-passkey="sign-in">Sign in with a passkey</button>
      <details class="new">
        <summary>New here? Create an account</summary>
        <form data-passkey="register" class="stack">
          <label>Your name <input name="name" required maxlength="60" autocomplete="name" placeholder="Ben Linder"></label>
          <button class="primary">Create account with a passkey</button>
          <p class="hint">Your device saves a passkey (Face ID, Touch ID, Windows Hello or a security key). No password.</p>
        </form>
      </details>
      <p class="error" data-passkey-error role="alert" hidden></p>
    </section>`;
}

/** A <time> the browser shows in the viewer's own time zone (app.js); UTC until then. */
export function fmtDate(d: Date): Html {
  const utc = d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return raw(`<time datetime="${esc(d.toISOString())}">${esc(utc)}</time>`);
}
