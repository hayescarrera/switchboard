// Passkey buttons, confirm prompts, local times, copy-to-clipboard. No inline scripts (CSP).
(function () {
  const W = window.SimpleWebAuthnBrowser;

  function showError(scope, msg) {
    const el = (scope.closest("section, form, main") || document).querySelector("[data-passkey-error]") ||
      document.querySelector("[data-passkey-error]");
    if (el) { el.textContent = msg; el.hidden = false; } else { alert(msg); }
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
    return data;
  }

  function friendly(err) {
    if (err && err.name === "NotAllowedError") return "Passkey request was cancelled or timed out.";
    if (err && err.name === "InvalidStateError") return "This device already has a passkey for this account.";
    return (err && err.message) || "Something went wrong. Try again.";
  }

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest('[data-passkey="sign-in"]');
    if (!btn) return;
    e.preventDefault();
    btn.disabled = true;
    try {
      const { challengeId, options } = await postJSON("/auth/passkey/sign-in/options");
      const response = await W.startAuthentication({ optionsJSON: options });
      await postJSON("/auth/passkey/sign-in/verify", { challengeId, response });
      location.reload();
    } catch (err) {
      showError(btn, friendly(err));
    } finally {
      btn.disabled = false;
    }
  });

  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (form.matches('[data-passkey="register"]')) {
      e.preventDefault();
      const btn = form.querySelector("button");
      btn.disabled = true;
      try {
        const name = form.querySelector('[name="name"]');
        const { challengeId, options } = await postJSON("/auth/passkey/register/options", { name: name ? name.value : undefined });
        const response = await W.startRegistration({ optionsJSON: options });
        await postJSON("/auth/passkey/register/verify", { challengeId, response });
        location.reload();
      } catch (err) {
        showError(form, friendly(err));
      } finally {
        btn.disabled = false;
      }
      return;
    }
    const ask = (e.submitter && e.submitter.dataset.confirm) || form.dataset.confirm;
    if (ask && !confirm(ask)) e.preventDefault();
  });

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-copy]");
    if (!el || !navigator.clipboard) return;
    navigator.clipboard.writeText(el.textContent.trim()).then(() => {
      el.classList.add("copied");
      setTimeout(() => el.classList.remove("copied"), 1200);
    });
  });

  for (const t of document.querySelectorAll("time[datetime]")) {
    const d = new Date(t.getAttribute("datetime"));
    if (!isNaN(d)) t.textContent = d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
})();
