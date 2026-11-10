// App shell: sign-in, list of flowcharts, sharing and autosave. The editor itself lives in editor.js.
(function () {
  const cfg = window.FLOWCHART_CONFIG || {};
  const $ = id => document.getElementById(id);
  const VIEWS = ["view-setup", "view-auth", "view-list", "view-editor"];
  function show(v) { VIEWS.forEach(x => { $(x).hidden = x !== v; }); window.scrollTo(0, 0); }
  // Build DOM safely: titles and emails come from other people, so never use innerHTML for them.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === "class") el.className = attrs[k];
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    }
    kids.flat().forEach(c => { if (c != null && c !== false) el.append(c); });
    return el;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- Setup check ----------
  const lib = window.supabase;
  if (!cfg.supabaseUrl || !cfg.supabaseKey || !lib || !lib.createClient) {
    if (cfg.supabaseUrl && cfg.supabaseKey) $("setupMsg").textContent = "The sign-in library didn't load. Check that vendor/supabase.js is in the repository, then reload.";
    show("view-setup");
    return;
  }
  let sb;
  try { sb = lib.createClient(cfg.supabaseUrl.trim(), cfg.supabaseKey.trim()); }
  catch (e) {
    $("setupMsg").textContent = "The values in config.js don't look right (" + e.message + "). Check the Project URL and key.";
    show("view-setup");
    return;
  }

  let user = null;       // { id, email }
  let current = null;    // open chart: { id, version, role }
  let recovering = false;

  // ---------- Confirm dialog ----------
  let confirmResolve = null;
  function confirmBox(text, yes) {
    $("confirmText").textContent = text; $("confirmYes").textContent = yes || "OK";
    $("confirmDlg").classList.add("open"); $("confirmNo").focus();
    return new Promise(r => { confirmResolve = r; });
  }
  function closeConfirm(v) { $("confirmDlg").classList.remove("open"); if (confirmResolve) { confirmResolve(v); confirmResolve = null; } }
  $("confirmYes").addEventListener("click", () => closeConfirm(true));
  $("confirmNo").addEventListener("click", () => closeConfirm(false));
  document.addEventListener("keydown", e => { if (e.key === "Escape") { closeConfirm(false); $("shareDlg").classList.remove("open"); } });

  // ---------- Sign in / sign up / reset ----------
  let authMode = "signin"; // signin | signup | forgot | newpass
  function setAuthMode(m, msg, ok) {
    authMode = m;
    $("authTitle").textContent = { signin: "Sign in", signup: "Create an account", forgot: "Reset your password", newpass: "Choose a new password" }[m];
    $("authSubmit").textContent = { signin: "Sign in", signup: "Create account", forgot: "Email me a reset link", newpass: "Save new password" }[m];
    $("emailWrap").hidden = m === "newpass";
    $("passWrap").hidden = m === "forgot";
    $("passLabel").textContent = m === "signin" ? "Password" : m === "newpass" ? "New password (at least 6 characters)" : "Password (at least 6 characters)";
    $("authPass").autocomplete = m === "signin" ? "current-password" : "new-password";
    $("authSwitch").textContent = m === "signin" ? "Create an account" : "Back to sign in";
    $("authSwitch").hidden = m === "newpass";
    $("authForgot").hidden = m !== "signin";
    authMsg(msg || "", ok);
  }
  function authMsg(t, ok) { const m = $("authMsg"); m.textContent = t; m.className = "msg " + (ok ? "ok" : "err"); }
  $("authSwitch").addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));
  $("authForgot").addEventListener("click", () => setAuthMode("forgot"));
  const here = () => location.origin + location.pathname;
  $("authForm").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("authEmail").value.trim(), pass = $("authPass").value;
    if (authMode !== "newpass" && !/^\S+@\S+\.\S+$/.test(email)) return authMsg("Enter your email address.");
    if (authMode !== "forgot" && pass.length < 6) return authMsg("Use a password of at least 6 characters.");
    const btn = $("authSubmit"); btn.disabled = true; authMsg("");
    try {
      if (authMode === "signin") {
        const { error } = await sb.auth.signInWithPassword({ email, password: pass });
        if (error) authMsg(/confirm/i.test(error.message) ? "Confirm your email first: open the link we emailed you, then sign in." : /invalid/i.test(error.message) ? "That email and password don't match. Try again or reset your password." : error.message);
      } else if (authMode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password: pass, options: { emailRedirectTo: here() } });
        if (error) authMsg(error.message);
        else if (!data.session) setAuthMode("signin", "Check your email for a confirmation link, then sign in here.", true);
      } else if (authMode === "forgot") {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: here() });
        if (error) authMsg(error.message); else setAuthMode("signin", "If that address has an account, a reset link is on its way.", true);
      } else {
        const { error } = await sb.auth.updateUser({ password: pass });
        if (error) authMsg(error.message);
        else { recovering = false; $("authPass").value = ""; setAuthMode("signin"); route(); }
      }
    } catch (err) { console.error(err); authMsg("Couldn't reach the server. Check your connection and try again."); }
    btn.disabled = false;
  });
  $("signOut").addEventListener("click", async () => { await sb.auth.signOut(); });

  sb.auth.onAuthStateChange((event, session) => {
    // Never call Supabase from inside this callback; defer instead.
    setTimeout(() => {
      if (event === "PASSWORD_RECOVERY") { recovering = true; setAuthMode("newpass"); show("view-auth"); return; }
      const u = session && session.user ? { id: session.user.id, email: (session.user.email || "").toLowerCase() } : null;
      const changed = (u && u.id) !== (user && user.id);
      user = u;
      if (changed || event === "INITIAL_SESSION") route();
    }, 0);
  });

  // ---------- Routing ----------
  const chartIdFromHash = () => { const m = /^#\/c\/([0-9a-fA-F-]{36})$/.exec(location.hash); return m ? m[1] : null; };
  let routing = Promise.resolve();
  function route() { routing = routing.then(doRoute, doRoute); return routing; }
  async function doRoute() {
    await leaveEditor();
    if (recovering) return;
    if (!user) { $("authPass").value = ""; if (authMode === "newpass") setAuthMode("signin"); show("view-auth"); return; }
    const id = chartIdFromHash();
    if (id) await openChart(id); else await showList();
  }
  window.addEventListener("hashchange", route);
  function go(hash) { if (location.hash === hash || (!hash && !location.hash)) route(); else location.hash = hash; }

  // ---------- List ----------
  function ago(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " hr ago";
    if (s < 86400 * 14) return Math.floor(s / 86400) + " days ago";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function listMsg(t, err) { const m = $("listMsg"); m.textContent = t || ""; m.className = "msg " + (err ? "err" : "ok"); }

  async function showList() {
    show("view-list");
    document.title = "Flowcharts";
    $("whoEmail").textContent = user.email;
    const mine = $("myCharts"), shared = $("sharedCharts");
    if (!mine.children.length) mine.replaceChildren(h("div", { class: "empty" }, "Loading…"));
    const [cr, sr] = await Promise.all([
      sb.from("charts").select("id,title,owner,owner_email,updated_at").order("updated_at", { ascending: false }),
      sb.from("chart_shares").select("chart_id,email,role")
    ]);
    if (cr.error || sr.error) {
      const e = cr.error || sr.error;
      const missing = /does not exist|schema cache|PGRST205|42P01/i.test((e.code || "") + " " + (e.message || ""));
      mine.replaceChildren(h("div", { class: "empty" }, missing
        ? "The database tables aren't set up yet. Run supabase/schema.sql in your Supabase project's SQL Editor, then reload."
        : "Couldn't load your flowcharts (" + e.message + "). Reload to try again."));
      shared.replaceChildren(); $("sharedHead").hidden = true;
      return;
    }
    const shares = sr.data || [];
    const myRows = cr.data.filter(c => c.owner === user.id), theirRows = cr.data.filter(c => c.owner !== user.id);
    mine.replaceChildren(...(myRows.length ? myRows.map(c => {
      const n = shares.filter(s => s.chart_id === c.id).length;
      return chartRow(c, "Edited " + ago(c.updated_at) + (n ? " · Shared with " + n + (n === 1 ? " person" : " people") : ""), [
        h("button", { class: "btn small", type: "button", onclick: () => duplicate(c) }, "Duplicate"),
        h("button", { class: "btn small danger", type: "button", onclick: () => removeChart(c) }, "Delete")
      ]);
    }) : [h("div", { class: "empty" }, "You don't have any flowcharts yet. Start one with the buttons above.")]));
    $("sharedHead").hidden = !theirRows.length;
    shared.replaceChildren(...theirRows.map(c => {
      const sh = shares.find(s => s.chart_id === c.id && s.email === user.email);
      const canEdit = sh && sh.role === "editor";
      return chartRow(c, "From " + (c.owner_email || "someone") + " · Edited " + ago(c.updated_at), [
        h("span", { class: "pill" + (canEdit ? " edit" : "") }, canEdit ? "Can edit" : "View only"),
        h("button", { class: "btn small", type: "button", onclick: () => duplicate(c) }, "Make my own copy"),
        h("button", { class: "btn small danger", type: "button", onclick: () => leaveShare(c) }, "Remove from my list")
      ]);
    }));
  }
  function chartRow(c, meta, acts) {
    return h("div", { class: "chartrow" },
      h("div", { class: "info" },
        h("a", { class: "t", href: "#/c/" + c.id }, c.title || "Untitled flowchart"),
        h("span", { class: "meta" }, meta)),
      h("div", { class: "acts" }, acts));
  }

  async function createChart(data) {
    listMsg("Creating…");
    const { data: row, error } = await sb.from("charts").insert({ title: data.title, data }).select("id").single();
    if (error) { listMsg("Couldn't create the flowchart: " + error.message, true); return; }
    listMsg("");
    go("#/c/" + row.id);
  }
  $("newBlank").addEventListener("click", () => createChart(FlowEditor.blank()));
  $("newExample").addEventListener("click", () => createChart(FlowEditor.example()));

  async function duplicate(c) {
    listMsg("Copying…");
    const { data: full, error } = await sb.from("charts").select("title,data").eq("id", c.id).single();
    if (error) { listMsg("Couldn't copy: " + error.message, true); return; }
    const title = (full.title || "Untitled flowchart") + " (copy)";
    const data = Object.assign({}, full.data, { title });
    const ins = await sb.from("charts").insert({ title, data }).select("id").single();
    if (ins.error) { listMsg("Couldn't copy: " + ins.error.message, true); return; }
    listMsg("Copied."); showList();
  }
  async function removeChart(c) {
    if (!await confirmBox(`Delete "${c.title || "Untitled flowchart"}" for good? Anyone it's shared with loses it too.`, "Delete")) return;
    const { error } = await sb.from("charts").delete().eq("id", c.id);
    if (error) listMsg("Couldn't delete: " + error.message, true); else listMsg("Deleted.");
    showList();
  }
  async function leaveShare(c) {
    if (!await confirmBox(`Remove "${c.title || "Untitled flowchart"}" from your list? The owner would need to share it with you again.`, "Remove")) return;
    const { error } = await sb.from("chart_shares").delete().eq("chart_id", c.id).eq("email", user.email);
    if (error) listMsg("Couldn't remove: " + error.message, true); else listMsg("Removed.");
    showList();
  }

  // ---------- Editor: open, autosave, conflicts ----------
  let saveTimer = null, saving = false, dirty = false, conflict = false;
  function setStatus(t, err) { const s = $("saveStatus"); s.textContent = t || ""; s.classList.toggle("err", !!err); }

  async function openChart(id) {
    const [cr, sr] = await Promise.all([
      sb.from("charts").select("*").eq("id", id).maybeSingle(),
      sb.from("chart_shares").select("role").eq("chart_id", id).eq("email", user.email).maybeSingle()
    ]);
    if (cr.error || !cr.data) {
      await showList();
      listMsg(cr.error ? "Couldn't open that flowchart: " + cr.error.message : "That flowchart doesn't exist or isn't shared with " + user.email + ".", true);
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
      return;
    }
    const row = cr.data;
    const role = row.owner === user.id ? "owner" : (sr.data && sr.data.role === "editor" ? "editor" : "viewer");
    current = { id: row.id, version: row.version, role };
    dirty = false; conflict = false; $("conflict").hidden = true;
    show("view-editor");
    const data = Object.assign({}, row.data, { title: row.title });
    FlowEditor.load(data, { readOnly: role === "viewer" });
    document.title = (row.title || "Untitled flowchart") + " · Flowcharts";
    $("shareBtn").hidden = role !== "owner";
    const pill = $("rolePill");
    pill.hidden = role === "owner";
    pill.textContent = role === "editor" ? "Shared by " + row.owner_email + " · can edit" : "View only · shared by " + row.owner_email;
    pill.className = "pill" + (role === "editor" ? " edit" : "");
    setStatus(role === "viewer" ? "" : "All changes saved");
  }

  FlowEditor.onChange(() => {
    if (!current || current.role === "viewer") return;
    dirty = true;
    if (conflict) return;
    setStatus("Unsaved changes…");
    clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 900);
  });

  async function saveNow() {
    clearTimeout(saveTimer);
    if (!current || !dirty || saving || conflict) return;
    const c = current, data = FlowEditor.getData();
    const title = (data.title || "").trim() || "Untitled flowchart";
    saving = true; dirty = false; setStatus("Saving…");
    let res;
    try {
      // The version check makes sure we never silently overwrite someone else's newer save.
      res = await sb.from("charts").update({ title, data, version: c.version + 1 }).eq("id", c.id).eq("version", c.version).select("version");
    } catch (e) { res = { error: e }; }
    saving = false;
    if (res.error) {
      dirty = true;
      if (current === c) { setStatus("Couldn't save. Trying again…", true); saveTimer = setTimeout(saveNow, 5000); }
      return;
    }
    if (!res.data || !res.data.length) {
      dirty = true; conflict = true;
      if (current === c) { $("conflict").hidden = false; setStatus("Not saved", true); }
      return;
    }
    c.version = res.data[0].version;
    document.title = title + " · Flowcharts";
    if (current !== c) return;
    if (dirty) saveNow(); else setStatus("All changes saved");
  }

  $("conflictReload").addEventListener("click", async () => {
    if (!current) return;
    const id = current.id; current = null; dirty = false; conflict = false;
    await openChart(id);
  });
  $("conflictKeep").addEventListener("click", async () => {
    if (!current) return;
    const c = current;
    const { data, error } = await sb.from("charts").select("version").eq("id", c.id).maybeSingle();
    if (error || !data) { setStatus("You no longer have access to this flowchart.", true); return; }
    c.version = data.version; conflict = false; $("conflict").hidden = true;
    await saveNow();
    if (conflict) setStatus("You may no longer have permission to edit this flowchart.", true);
  });

  async function leaveEditor() {
    if (!current) return;
    clearTimeout(saveTimer);
    while (saving) await sleep(50);
    if (dirty && !conflict) await saveNow();
    current = null; dirty = false; conflict = false;
    $("shareDlg").classList.remove("open");
  }
  $("backBtn").addEventListener("click", () => go(""));
  window.addEventListener("beforeunload", e => { if (current && (dirty || saving)) { e.preventDefault(); e.returnValue = ""; } });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(); });

  // ---------- Sharing ----------
  function shareMsg(t, err) { const m = $("shareMsg"); m.textContent = t || ""; m.className = "msg " + (err ? "err" : "ok"); }
  async function loadShares() {
    const id = current && current.id; if (!id) return;
    const { data, error } = await sb.from("chart_shares").select("email,role").eq("chart_id", id).order("email");
    const list = $("shareList");
    if (error) { shareMsg("Couldn't load who has access: " + error.message, true); return; }
    list.replaceChildren(...(data.length ? data.map(s => {
      const sel = h("select", { "aria-label": "Access for " + s.email },
        h("option", { value: "viewer", selected: s.role === "viewer" }, "Can view"),
        h("option", { value: "editor", selected: s.role === "editor" }, "Can edit"));
      sel.addEventListener("change", async () => {
        const r = await sb.from("chart_shares").update({ role: sel.value }).eq("chart_id", id).eq("email", s.email);
        shareMsg(r.error ? "Couldn't change access: " + r.error.message : "Updated " + s.email + ".", !!r.error);
      });
      return h("div", { class: "sharerow" }, h("span", { class: "em" }, s.email), sel,
        h("button", { class: "btn small danger", type: "button", onclick: async () => {
          const r = await sb.from("chart_shares").delete().eq("chart_id", id).eq("email", s.email);
          shareMsg(r.error ? "Couldn't remove: " + r.error.message : "Removed " + s.email + ".", !!r.error);
          loadShares();
        } }, "Remove"));
    }) : [h("p", { class: "note" }, "Only you can see this flowchart.")]));
  }
  $("shareBtn").addEventListener("click", () => { shareMsg(""); $("shareList").replaceChildren(); $("shareDlg").classList.add("open"); $("shareEmail").focus(); loadShares(); });
  $("shareClose").addEventListener("click", () => $("shareDlg").classList.remove("open"));
  $("shareForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (!current) return;
    const email = $("shareEmail").value.trim().toLowerCase(), role = $("shareRole").value;
    if (!/^\S+@\S+\.\S+$/.test(email)) return shareMsg("Enter a full email address.", true);
    if (email === user.email) return shareMsg("That's your own address. You already own this flowchart.", true);
    const { error } = await sb.from("chart_shares").upsert({ chart_id: current.id, email, role }, { onConflict: "chart_id,email" });
    if (error) return shareMsg("Couldn't share: " + error.message, true);
    $("shareEmail").value = ""; shareMsg("Shared with " + email + ".");
    loadShares();
  });

  setAuthMode("signin");
})();
