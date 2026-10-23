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

/** Sign-in / create-account block: email + password first, passkey as an option. Returns to `next`. */
export function signInBlock(lead: string, opts: { next: string; error?: string | null; email?: string }): Html {
  return html`
    <section class="card">
      <p class="lead">${lead}</p>
      ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
      <form method="post" action="/auth/password/sign-in" class="stack">
        <input type="hidden" name="next" value="${opts.next}">
        <label>Email <input name="email" type="email" required autocomplete="username" value="${opts.email ?? ""}"></label>
        <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
        <button class="primary">Sign in</button>
      </form>
      <details class="new">
        <summary>New here? Create an account</summary>
        <form method="post" action="/auth/password/register" class="stack">
          <input type="hidden" name="next" value="${opts.next}">
          <label>Your name <input name="name" required maxlength="60" autocomplete="name"></label>
          <label>Email <input name="email" type="email" required autocomplete="username"></label>
          <label>Password <input name="password" type="password" required minlength="10" autocomplete="new-password"></label>
          <p class="hint">At least 10 characters.</p>
          <button class="primary">Create account</button>
        </form>
      </details>
      <details class="new">
        <summary>Use a passkey instead</summary>
        <div class="stack">
          <button type="button" data-passkey="sign-in">Sign in with a passkey</button>
          <form data-passkey="register" class="stack">
            <label>Your name <input name="name" required maxlength="60" autocomplete="name"></label>
            <button>Create account with a passkey</button>
          </form>
        </div>
      </details>
      <p class="error" data-passkey-error role="alert" hidden></p>
    </section>`;
}

/** A <time> the browser shows in the viewer's own time zone (app.js); UTC until then. */
export function fmtDate(d: Date): Html {
  const utc = d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return raw(`<time datetime="${esc(d.toISOString())}">${esc(utc)}</time>`);
}
