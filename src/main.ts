import {
  AuthError,
  MissingIdentityError,
  getUser,
  handleAuthCallback,
  login,
  logout,
  onAuthChange,
  requestPasswordRecovery,
  signup,
  updateUser,
  type User,
} from "@netlify/identity";

type Resource = "artists" | "releases" | "tracks";
type Row = Record<string, any> & { id: number };

type Field = {
  name: string;
  label: string;
  type?: "text" | "code" | "textarea" | "date" | "number" | "checkbox" | "select" | "artist" | "release";
  hint?: string;
  placeholder?: string;
  required?: boolean;
  full?: boolean;
  options?: [string, string][];
};

const app = document.querySelector<HTMLDivElement>("#app")!;

const state = {
  user: null as User | null,
  tab: "tracks" as Resource,
  query: "",
  data: { artists: [], releases: [], tracks: [] } as Record<Resource, Row[]>,
  loaded: false,
};

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const authMessage = (error: unknown) => {
  if (error instanceof MissingIdentityError) return "Accounts aren't available here yet. Try again on the deployed site.";
  if (error instanceof AuthError) {
    if (error.status === 401) return "Invalid email or password.";
    if (error.status === 403) return "Signups are currently closed.";
    return error.message;
  }
  return "Something went wrong. Please try again.";
};

// ---------- metadata definitions ----------

const RELEASE_TYPES: [string, string][] = [
  ["single", "Single"],
  ["ep", "EP"],
  ["album", "Album"],
  ["compilation", "Compilation"],
];

const FIELDS: Record<Resource, Field[]> = {
  artists: [
    { name: "name", label: "Artist / stage name", required: true },
    { name: "legalName", label: "Legal name" },
    { name: "ipi", label: "IPI name number", type: "code", placeholder: "00123456789", hint: "From your PRO. 9–11 digits." },
    { name: "isni", label: "ISNI", type: "code", placeholder: "0000 0001 2345 6789", hint: "16 characters." },
    { name: "pro", label: "Performing rights org", placeholder: "ASCAP, BMI, PRS, SOCAN…" },
    { name: "spotifyUrl", label: "Spotify artist URL" },
    { name: "appleMusicUrl", label: "Apple Music artist URL", full: true },
    { name: "bio", label: "Short bio", type: "textarea", full: true },
  ],
  releases: [
    { name: "title", label: "Release title", required: true, full: true },
    { name: "artistId", label: "Primary artist", type: "artist" },
    { name: "releaseType", label: "Type", type: "select", options: RELEASE_TYPES },
    { name: "upc", label: "UPC / EAN", type: "code", placeholder: "012345678905", hint: "12 or 13 digits, from your distributor." },
    { name: "releaseDate", label: "Release date", type: "date" },
    { name: "label", label: "Label / imprint", full: true },
  ],
  tracks: [
    { name: "title", label: "Track title", required: true, full: true },
    { name: "artistId", label: "Primary artist", type: "artist" },
    { name: "releaseId", label: "Release", type: "release" },
    { name: "isrc", label: "ISRC", type: "code", placeholder: "US-S1Z-24-00001", hint: "Identifies this specific recording." },
    { name: "iswc", label: "ISWC", type: "code", placeholder: "T-123.456.789-0", hint: "Identifies the underlying composition." },
    { name: "durationSeconds", label: "Duration (seconds)", type: "number" },
    { name: "genre", label: "Genre" },
    { name: "writers", label: "Writers / splits", type: "textarea", full: true, placeholder: "Jane Doe 50%, John Roe 50%" },
    { name: "explicit", label: "Explicit lyrics", type: "checkbox", full: true },
  ],
};

const LABELS: Record<Resource, [string, string]> = {
  artists: ["Artists", "artist"],
  releases: ["Releases", "release"],
  tracks: ["Tracks", "track"],
};

// Codes that distributors and PROs typically ask for.
const KEY_CODES: Record<Resource, [string, string][]> = {
  artists: [["ipi", "IPI"], ["isni", "ISNI"]],
  releases: [["upc", "UPC"]],
  tracks: [["isrc", "ISRC"], ["iswc", "ISWC"]],
};

const fmtIsrc = (v: string) => (v.length === 12 ? `${v.slice(0, 2)}-${v.slice(2, 5)}-${v.slice(5, 7)}-${v.slice(7)}` : v);
const fmtIsni = (v: string) => v.replace(/(.{4})(?=.)/g, "$1 ");
const fmtIswc = (v: string) => (v.length === 11 ? `${v[0]}-${v.slice(1, 4)}.${v.slice(4, 7)}.${v.slice(7, 10)}-${v[10]}` : v);
const FORMAT: Record<string, (v: string) => string> = { isrc: fmtIsrc, isni: fmtIsni, iswc: fmtIswc };
const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const nameOf = (resource: Resource, id: number | null) => {
  if (!id) return null;
  const row = state.data[resource].find((r) => r.id === id);
  return row ? row.name ?? row.title : null;
};

const missingCount = (resource: Resource) =>
  state.data[resource].reduce((n, row) => n + KEY_CODES[resource].filter(([k]) => !row[k]).length, 0);

// ---------- API ----------

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 401) {
    state.user = null;
    render();
    throw new Error("Your session expired. Please log in again.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (null as T) : res.json();
}

async function loadAll() {
  const [artists, releases, tracks] = await Promise.all([api<Row[]>("artists"), api<Row[]>("releases"), api<Row[]>("tracks")]);
  state.data = { artists, releases, tracks };
  state.loaded = true;
}

// ---------- auth views ----------

type AuthMode = "login" | "signup" | "forgot" | "reset";

function renderAuth(mode: AuthMode = "login", notice = "") {
  const titles: Record<AuthMode, string> = {
    login: "Welcome back",
    signup: "Create your hub",
    forgot: "Reset password",
    reset: "Choose a new password",
  };

  app.innerHTML = `
    <main class="auth">
      <section class="auth-hero">
        <div class="brand">Strezless Nexus</div>
        <div>
          <h1>Your catalog,<br/><em>properly coded.</em></h1>
          <p>One place for indie artists to keep every identifier straight — so royalties, credits and distribution land where they should.</p>
          <div class="codes"><span>IPI</span><span>ISNI</span><span>ISRC</span><span>ISWC</span><span>UPC</span><span>PRO</span></div>
        </div>
        <p class="hint">Each account's catalog is private to that account.</p>
      </section>
      <section class="auth-panel">
        <form class="auth-card" id="auth-form" novalidate>
          ${
            mode === "login" || mode === "signup"
              ? `<div class="tabs">
                  <button type="button" data-mode="login" class="${mode === "login" ? "active" : ""}">Log in</button>
                  <button type="button" data-mode="signup" class="${mode === "signup" ? "active" : ""}">Sign up</button>
                </div>`
              : ""
          }
          <h2>${titles[mode]}</h2>
          ${notice ? `<div class="msg info">${esc(notice)}</div>` : ""}
          <div class="msg error" id="auth-error" hidden></div>
          ${mode === "signup" ? `<label>Artist or full name<input name="name" autocomplete="name" required /></label>` : ""}
          ${mode !== "reset" ? `<label>Email<input name="email" type="email" autocomplete="email" required /></label>` : ""}
          ${
            mode !== "forgot"
              ? `<label>${mode === "reset" ? "New password" : "Password"}<input name="password" type="password" autocomplete="${
                  mode === "login" ? "current-password" : "new-password"
                }" required minlength="6" /></label>`
              : ""
          }
          <button class="primary" type="submit">${
            { login: "Log in", signup: "Create account", forgot: "Send reset link", reset: "Save password" }[mode]
          }</button>
          ${mode === "login" ? `<button type="button" class="linkish" data-mode="forgot">Forgot your password?</button>` : ""}
          ${mode === "forgot" ? `<button type="button" class="linkish" data-mode="login">Back to log in</button>` : ""}
        </form>
      </section>
    </main>`;

  app.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => renderAuth(b.dataset.mode as AuthMode)),
  );

  const form = app.querySelector<HTMLFormElement>("#auth-form")!;
  const errorBox = app.querySelector<HTMLDivElement>("#auth-error")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const email = String(fd.get("email") ?? "").trim();
    const password = String(fd.get("password") ?? "");
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    errorBox.hidden = true;
    submit.disabled = true;
    try {
      if (mode === "login") {
        state.user = await login(email, password);
        await enterApp();
      } else if (mode === "signup") {
        const user = await signup(email, password, { full_name: String(fd.get("name") ?? "").trim() });
        if (user.confirmedAt) {
          state.user = user;
          await enterApp();
        } else {
          renderAuth("login", "Check your inbox to confirm your email, then log in.");
        }
      } else if (mode === "forgot") {
        await requestPasswordRecovery(email);
        renderAuth("login", "If that email has an account, a reset link is on its way.");
      } else {
        await updateUser({ password });
        state.user = await getUser();
        await enterApp();
      }
    } catch (error) {
      errorBox.textContent = authMessage(error);
      errorBox.hidden = false;
      submit.disabled = false;
    }
  });
}

// ---------- catalog views ----------

function renderRow(resource: Resource, row: Row) {
  const chips: string[] = [];
  for (const [key, label] of KEY_CODES[resource]) {
    chips.push(
      row[key]
        ? `<span class="chip"><b>${label}</b>${esc((FORMAT[key] ?? String)(row[key]))}</span>`
        : `<span class="chip missing">No ${label}</span>`,
    );
  }

  let title = row.title ?? row.name;
  let sub: string[] = [];
  if (resource === "artists") {
    if (row.legalName) sub.push(row.legalName);
    if (row.pro) chips.push(`<span class="chip"><b>PRO</b>${esc(row.pro)}</span>`);
  } else if (resource === "releases") {
    const artist = nameOf("artists", row.artistId);
    if (artist) sub.push(artist);
    sub.push(RELEASE_TYPES.find(([v]) => v === row.releaseType)?.[1] ?? row.releaseType);
    if (row.releaseDate) sub.push(row.releaseDate);
    if (row.label) sub.push(row.label);
    const count = state.data.tracks.filter((t) => t.releaseId === row.id).length;
    sub.push(`${count} track${count === 1 ? "" : "s"}`);
  } else {
    const artist = nameOf("artists", row.artistId);
    const release = nameOf("releases", row.releaseId);
    if (artist) sub.push(artist);
    if (release) sub.push(`from ${release}`);
    if (row.durationSeconds != null) sub.push(fmtDuration(row.durationSeconds));
    if (row.genre) sub.push(row.genre);
    if (row.explicit) chips.push(`<span class="chip flag">E</span>`);
  }

  return `
    <article class="row">
      <div>
        <h3>${esc(title)}</h3>
        ${sub.length ? `<div class="sub">${sub.map(esc).join(" · ")}</div>` : ""}
        <div class="chips">${chips.join("")}</div>
      </div>
      <div class="actions">
        <button data-edit="${row.id}">Edit</button>
        <button class="danger ghost" data-delete="${row.id}">Delete</button>
      </div>
    </article>`;
}

function renderApp() {
  if (!state.user) return renderAuth();
  const { tab, data, query } = state;
  const displayName = state.user.name || state.user.email;
  const totalMissing = missingCount("artists") + missingCount("releases") + missingCount("tracks");
  const q = query.toLowerCase();
  const rows = data[tab].filter((r) =>
    !q ? true : Object.values(r).some((v) => typeof v === "string" && v.toLowerCase().includes(q)),
  );
  const [plural, singular] = LABELS[tab];

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">Strezless Nexus</div>
        <div class="who">
          <span>${esc(state.user.email)}</span>
          <button class="ghost" id="logout">Log out</button>
        </div>
      </header>

      <section class="hello">
        <h1>${esc(displayName?.split(" ")[0] ?? "Your")}'s catalog</h1>
        <p>Keep the codes that collect your royalties complete and in one place.</p>
      </section>

      <section class="stats">
        <div class="stat"><b>${data.artists.length}</b><span>Artists</span></div>
        <div class="stat"><b>${data.releases.length}</b><span>Releases</span></div>
        <div class="stat"><b>${data.tracks.length}</b><span>Tracks</span></div>
        <div class="stat ${totalMissing ? "warn" : "good"}"><b>${totalMissing}</b><span>Missing codes</span></div>
      </section>

      <nav class="nav">
        ${(Object.keys(LABELS) as Resource[])
          .map(
            (r) =>
              `<button class="tab ${r === tab ? "active" : ""}" data-tab="${r}">${LABELS[r][0]}${
                missingCount(r) ? `<small>${missingCount(r)} missing</small>` : ""
              }</button>`,
          )
          .join("")}
        <span class="spacer"></span>
        <input class="search" id="search" placeholder="Search ${plural.toLowerCase()}…" value="${esc(query)}" />
        <button class="primary" id="add">+ Add ${singular}</button>
      </nav>

      <section class="list">
        ${
          rows.length
            ? rows.map((r) => renderRow(tab, r)).join("")
            : data[tab].length
              ? `<div class="empty"><h3>No matches</h3>Nothing matches “${esc(query)}”.</div>`
              : `<div class="empty"><h3>No ${plural.toLowerCase()} yet</h3>${
                  tab === "tracks" && !data.artists.length
                    ? "Tip: add your artist profile first so tracks can be credited."
                    : `Add your first ${singular} to start building your catalog.`
                }</div>`
        }
      </section>
    </div>
    <dialog id="editor"></dialog>`;

  app.querySelector("#logout")!.addEventListener("click", async () => {
    await logout().catch(() => {});
    state.user = null;
    state.loaded = false;
    renderAuth();
  });
  app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab as Resource;
      state.query = "";
      renderApp();
    }),
  );
  const search = app.querySelector<HTMLInputElement>("#search")!;
  search.addEventListener("input", () => {
    state.query = search.value;
    renderApp();
    const next = app.querySelector<HTMLInputElement>("#search")!;
    next.focus();
    next.setSelectionRange(next.value.length, next.value.length);
  });
  app.querySelector("#add")!.addEventListener("click", () => openEditor(tab));
  app.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openEditor(tab, data[tab].find((r) => r.id === Number(b.dataset.edit)))),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((b) =>
    b.addEventListener("click", () => removeRow(tab, Number(b.dataset.delete))),
  );
}

function fieldHtml(field: Field, value: any) {
  const id = `f-${field.name}`;
  const req = field.required ? "required" : "";
  const cls = field.full ? "full" : "";
  const hint = field.hint ? `<span class="hint">${esc(field.hint)}</span>` : "";
  const ph = field.placeholder ? `placeholder="${esc(field.placeholder)}"` : "";

  switch (field.type) {
    case "checkbox":
      return `<label class="check ${cls}"><input type="checkbox" name="${field.name}" ${value ? "checked" : ""} /> ${esc(field.label)}</label>`;
    case "textarea":
      return `<label class="${cls}">${esc(field.label)}<textarea id="${id}" name="${field.name}" ${ph}>${esc(value)}</textarea>${hint}</label>`;
    case "select":
    case "artist":
    case "release": {
      const options: [string, string][] =
        field.type === "select"
          ? field.options!
          : [
              ["", "— None —"],
              ...state.data[field.type === "artist" ? "artists" : "releases"].map(
                (r): [string, string] => [String(r.id), r.name ?? r.title],
              ),
            ];
      return `<label class="${cls}">${esc(field.label)}<select id="${id}" name="${field.name}">${options
        .map(([v, l]) => `<option value="${esc(v)}" ${String(value ?? "") === v ? "selected" : ""}>${esc(l)}</option>`)
        .join("")}</select>${hint}</label>`;
    }
    default: {
      const type = field.type === "date" ? "date" : field.type === "number" ? "number" : "text";
      const shown = value != null && FORMAT[field.name] ? FORMAT[field.name](value) : value;
      return `<label class="${cls}">${esc(field.label)}<input id="${id}" name="${field.name}" type="${type}" ${
        field.type === "number" ? 'min="0" step="1"' : ""
      } class="${field.type === "code" ? "code" : ""}" value="${esc(shown)}" ${ph} ${req} />${hint}</label>`;
    }
  }
}

function openEditor(resource: Resource, row?: Row) {
  const dialog = app.querySelector<HTMLDialogElement>("#editor")!;
  const singular = LABELS[resource][1];
  dialog.innerHTML = `
    <form method="dialog" id="editor-form" novalidate>
      <h2>${row ? "Edit" : "New"} ${singular}</h2>
      <div class="msg error" id="editor-error" hidden></div>
      <div class="grid2">${FIELDS[resource].map((f) => fieldHtml(f, row?.[f.name])).join("")}</div>
      <div class="dialog-actions">
        <button type="button" class="ghost" id="cancel">Cancel</button>
        <button type="submit" class="primary">${row ? "Save changes" : `Add ${singular}`}</button>
      </div>
    </form>`;
  dialog.showModal();
  dialog.querySelector<HTMLInputElement>("input, textarea")?.focus();
  dialog.querySelector("#cancel")!.addEventListener("click", () => dialog.close());

  const form = dialog.querySelector<HTMLFormElement>("#editor-form")!;
  const errorBox = dialog.querySelector<HTMLDivElement>("#editor-error")!;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    for (const f of FIELDS[resource]) {
      const el = form.elements.namedItem(f.name) as HTMLInputElement;
      body[f.name] = f.type === "checkbox" ? el.checked : el.value;
    }
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    submit.disabled = true;
    errorBox.hidden = true;
    try {
      const saved = await api<Row>(row ? `${resource}/${row.id}` : resource, {
        method: row ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      const list = state.data[resource];
      state.data[resource] = row ? list.map((r) => (r.id === saved.id ? saved : r)) : [saved, ...list];
      dialog.close();
      renderApp();
    } catch (error) {
      errorBox.textContent = (error as Error).message;
      errorBox.hidden = false;
      submit.disabled = false;
    }
  });
}

async function removeRow(resource: Resource, id: number) {
  const row = state.data[resource].find((r) => r.id === id);
  if (!row || !confirm(`Delete “${row.name ?? row.title}”? This can't be undone.`)) return;
  try {
    await api(`${resource}/${id}`, { method: "DELETE" });
    // Linked items keep existing but lose the reference, matching the database behavior.
    await loadAll();
    renderApp();
  } catch (error) {
    alert((error as Error).message);
  }
}

// ---------- boot ----------

async function enterApp() {
  app.innerHTML = `<p class="boot">Loading your catalog…</p>`;
  try {
    await loadAll();
    renderApp();
  } catch (error) {
    if (state.user) app.innerHTML = `<p class="boot">${esc((error as Error).message)}</p>`;
  }
}

function render() {
  if (state.user) renderApp();
  else renderAuth();
}

async function boot() {
  try {
    const result = await handleAuthCallback();
    if (result?.type === "recovery") return renderAuth("reset", "You're verified. Set a new password to continue.");
    if (result?.type === "confirmation") {
      state.user = result.user;
      return enterApp();
    }
  } catch (error) {
    renderAuth("login", authMessage(error));
    return;
  }

  state.user = await getUser();
  if (state.user) await enterApp();
  else renderAuth();

  onAuthChange((event, user) => {
    if (event === "logout" && state.user) {
      state.user = null;
      state.loaded = false;
      renderAuth();
    } else if (event === "login" && user && !state.user) {
      state.user = user;
      enterApp();
    }
  });
}

boot();
