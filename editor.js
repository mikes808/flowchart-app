(function () {
  const TYPES = { start: "Start", step: "Step", decision: "Decision", wait: "Wait", end: "End" };
  const UNITS = { min: 1, hr: 60, day: 480, wk: 2400 }; // day = 8 working hours, week = 5 days
  const UNIT_LABEL = { min: "min", hr: "hr", day: "day", wk: "wk" };
  const BRANCH_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="4" cy="3" r="1.6"/><circle cx="4" cy="13" r="1.6"/><circle cx="12" cy="5" r="1.6"/><path d="M4 4.6v6.8M12 6.6c0 3-8 2-8 4.8"/></svg>';
  let uid = 1;
  const mk = (type, name, desc, dur, unit, extra) => Object.assign({ kind: "step", id: uid++, type, name, desc, dur, unit }, extra || {});
  const mkSplit = (labels, branches, merge) => ({ kind: "split", id: uid++, labels, branches, merge });
  const isSplit = it => it && it.kind === "split";

  const template = () => [
    mk("start", "Signed contract received", "Sales hands off to onboarding", 0, "min"),
    mk("step", "Send welcome email", "Include login link and kickoff scheduler", 15, "min"),
    mk("step", "Kickoff call", "Confirm goals, contacts and timeline", 1, "hr"),
    mk("decision", "Data import needed?", "", 10, "min", { yes: "Yes", no: "No", noTarget: null }),
    mkSplit(["Yes", "No"], [
      [mk("step", "Import customer data", "Map fields, run test import, verify", 4, "hr"),
       mk("wait", "Customer review", "Customer checks imported records", 2, "day")],
      [mk("step", "Configure default settings", "Use the standard workspace setup", 45, "min")]
    ], true),
    mk("step", "Training session", "Walk through core workflows", 90, "min"),
    mk("end", "Account live", "Hand off to account manager", 0, "min")
  ];

  // ---------- State ----------
  let state;
  function maxId(items) { let m = 0; walk(items, it => { m = Math.max(m, +it.id || 0); }); return m; }
  function walk(items, fn) { items.forEach(it => { fn(it); if (isSplit(it)) it.branches.forEach(b => walk(b, fn)); }); }
  let readOnly = false;
  const changeCbs = [];
  function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  function withDefaults(s) {
    if (s.startDate === undefined) s.startDate = todayISO();
    if (!s.startTime) s.startTime = "09:00";
    if (s.skipWeekends === undefined) s.skipWeekends = true;
    return s;
  }
  function save() { if (readOnly) return; changeCbs.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }

  // ---------- Time ----------
  const minutes = s => (parseFloat(s.dur) || 0) * (UNITS[s.unit] || 1);
  function fmt(m) {
    m = Math.round(m);
    if (m === 0) return "0m";
    const d = Math.floor(m / 480), h = Math.floor((m % 480) / 60), mm = m % 60;
    return [d && d + "d", h && h + "h", mm && mm + "m"].filter(Boolean).join(" ");
  }
  // Start time of every step; parallel chains run side by side, a rejoin waits for the slowest chain.
  function computeTimes(items, start, out) {
    let t = start;
    for (const it of items) {
      if (isSplit(it)) t = Math.max(t, ...it.branches.map(b => computeTimes(b, t, out)));
      else { out[it.id] = t; t += minutes(it); }
    }
    return t;
  }
  // Shortest way through: either/or chains take the quickest one.
  function computeMin(items, start) {
    let t = start;
    for (const it of items) t = isSplit(it) ? Math.min(...it.branches.map(b => computeMin(b, t))) : t + minutes(it);
    return t;
  }

  // ---------- Calendar ----------
  // Work time runs on a working calendar: 8-hour days from the chosen start time, weekdays only unless weekends count.
  const DAY = 480;
  function startMoment() {
    if (!state.startDate) return null;
    const [y, m, d] = state.startDate.split("-").map(Number);
    const [hh, mi] = (state.startTime || "09:00").split(":").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d, hh || 0, mi || 0);
  }
  function calendar() {
    const [sh, sm] = (state.startTime || "09:00").split(":").map(Number);
    const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh || 0, sm || 0);
    const dayEnd = d => new Date(dayStart(d).getTime() + DAY * 60000);
    const isWork = d => !state.skipWeekends || (d.getDay() !== 0 && d.getDay() !== 6);
    const nextDay = d => { let n = dayStart(d); do { n = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, sh || 0, sm || 0); } while (!isWork(n)); return n; };
    function norm(c) { if (!isWork(c) || c >= dayEnd(c)) return nextDay(c); if (c < dayStart(c)) return dayStart(c); return c; }
    // forStart: a step that would begin at closing time begins the next working morning instead.
    function add(start, mins, forStart) {
      let c = norm(new Date(start));
      let left = mins;
      while (left > 0) {
        const room = (dayEnd(c) - c) / 60000;
        if (left <= room) { c = new Date(c.getTime() + left * 60000); left = 0; }
        else { left -= room; c = nextDay(c); }
      }
      if (forStart && c >= dayEnd(c)) c = nextDay(c);
      return c;
    }
    return { add };
  }
  const sameYear = d => d.getFullYear() === new Date().getFullYear();
  const fmtDate = (d, long) => d.toLocaleDateString(undefined, Object.assign({ month: "short", day: "numeric" }, long ? { weekday: "short" } : {}, sameYear(d) ? {} : { year: "numeric" }));
  const fmtTime = d => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  function startsText(id) {
    const base = "starts +" + fmt(times[id] || 0);
    const s0 = startMoment(); if (!s0) return base;
    return base + " \u00b7 " + fmtDate(calendar().add(s0, times[id] || 0, true), true);
  }
  function projection(total) {
    const s0 = startMoment();
    if (!s0) return null;
    const cal = calendar(), late = cal.add(s0, total), early = cal.add(s0, computeMin(state.items, 0));
    return { early, late, start: cal.add(s0, 0, true) };
  }
  function updateProjection(total) {
    const pd = document.getElementById("projDate"), pw = document.getElementById("projWin");
    const pr = projection(total);
    pw.classList.remove("warn");
    if (!firstStart()) { pd.textContent = "-"; pw.textContent = "Add a Start step to set a start date"; pw.classList.add("warn"); }
    else if (!pr) { pd.textContent = "-"; pw.textContent = "Set a start date in the Start step"; pw.classList.add("warn"); }
    else {
      pd.textContent = fmtDate(pr.late, true) + ", " + fmtTime(pr.late);
      pw.textContent = pr.early.getTime() === pr.late.getTime() ? "Single path, no variation" : `Window ${fmtDate(pr.early)} - ${fmtDate(pr.late)} (shortest to longest path)`;
    }
    const fin = document.getElementById("finInStart");
    if (fin) fin.textContent = pr ? fmtDate(pr.late, true) + ", " + fmtTime(pr.late) : "set a date";
  }
  function firstStart() { let f = null; walk(state.items, it => { if (!f && !isSplit(it) && it.type === "start") f = it; }); return f; }

  function numbering(items) { const map = {}, list = []; walk(items, it => { if (!isSplit(it)) { list.push(it); map[it.id] = list.length; } }); return { map, list }; }

  // ---------- Lookup ----------
  function locate(id, items = state.items, parent = null) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.id === id) return { seq: items, i, item: it, parent };
      if (isSplit(it)) for (let b = 0; b < it.branches.length; b++) { const r = locate(id, it.branches[b], { split: it, bi: b }); if (r) return r; }
    }
    return null;
  }

  // ---------- Render ----------
  const flow = document.getElementById("flow");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let times = {}, nums = {};
  const letter = i => String.fromCharCode(65 + (i % 26));

  function render() {
    document.getElementById("chartTitle").value = state.title;
    times = {}; const total = computeTimes(state.items, 0, times);
    const n = numbering(state.items); nums = n.map;
    flow.innerHTML = `<div class="seq top">${seqHtml(state.items)}</div>`;
    flow.querySelectorAll("textarea").forEach(autosize);
    document.getElementById("totTime").textContent = fmt(total);
    document.getElementById("totSteps").textContent = n.list.length;
    updateProjection(total);
    if (typeof markPicked === "function") markPicked();
    if (readOnly) flow.querySelectorAll("input, select, textarea").forEach(el => { el.disabled = true; });
    document.getElementById("chartTitle").disabled = readOnly;
  }
  function refreshTimes() {
    times = {}; const total = computeTimes(state.items, 0, times);
    flow.querySelectorAll(".node").forEach(el => { const s = el.querySelector(".starts"); if (s) s.textContent = startsText(+el.dataset.id); });
    document.getElementById("totTime").textContent = fmt(total);
    updateProjection(total);
  }

  function seqHtml(items) {
    let html = "";
    items.forEach((it, i) => {
      html += isSplit(it) ? splitHtml(it, items, i) : nodeHtml(it, items, i);
      const next = items[i + 1];
      if (next && !(isSplit(it) && !it.merge)) {
        const plain = isSplit(next);
        const yes = !isSplit(it) && it.type === "decision" && !plain ? `<span class="yes">${esc(it.yes || "Yes")}</span>` : "";
        html += `<div class="connector${plain ? " plain" : ""}">${yes}<button class="add" data-a="ins" data-after="${it.id}" type="button" title="Insert step here" aria-label="Insert step here">+</button></div>`;
      }
    });
    return html;
  }

  function nodeHtml(s, seq, i) {
    const n = nums[s.id];
    const opts = Object.keys(TYPES).map(k => `<option value="${k}"${k === s.type ? " selected" : ""}>${TYPES[k]}</option>`).join("");
    const units = Object.keys(UNITS).map(k => `<option value="${k}"${k === s.unit ? " selected" : ""}>${UNIT_LABEL[k]}</option>`).join("");
    let row = "";
    if (s.type === "decision" && !isSplit(seq[i + 1])) {
      const all = numbering(state.items).list;
      const targets = all.filter(x => x.id !== s.id).map(x => `<option value="${x.id}"${x.id === s.noTarget ? " selected" : ""}>${nums[x.id]}. ${esc(x.name || "Untitled")}</option>`).join("");
      row = `<div class="branchrow">
        <span><label for="yes${s.id}">Down arrow label</label><input id="yes${s.id}" data-f="yes" value="${esc(s.yes || "Yes")}"></span>
        <span><input id="no${s.id}" data-f="no" aria-label="Other answer label" value="${esc(s.no || "No")}"><label for="nt${s.id}">goes to</label>
        <select id="nt${s.id}" data-f="noTarget"><option value="">(choose step)</option>${targets}</select></span>
        <span>or use Branch to draw it as its own chain</span>
      </div>`;
    }
    const fs = firstStart();
    if (fs && fs.id === s.id) {
      row += `<div class="datebox">
        <span><label for="gStartDate">Start date</label><input type="date" id="gStartDate" data-g="startDate" value="${esc(state.startDate)}"></span>
        <span><label for="gStartTime">Workday starts</label><input type="time" id="gStartTime" data-g="startTime" value="${esc(state.startTime)}"></span>
        <span><input type="checkbox" id="gSkipWk" data-g="skipWeekends"${state.skipWeekends ? " checked" : ""}><label for="gSkipWk">Skip weekends</label></span>
        <span class="fin">Projected finish: <b id="finInStart"></b></span>
      </div>`;
    }
    return `<div class="item"><section class="node" data-type="${s.type}" data-id="${s.id}" aria-label="Step ${n}">
      <div class="main">
        <div class="typeline"><span class="stepno">${String(n).padStart(2, "0")}</span>
          <select class="typeSel" data-f="type" aria-label="Shape type for step ${n}">${opts}</select>
          <span class="starts">${esc(startsText(s.id))}</span></div>
        <input class="field name" data-f="name" id="n${s.id}" aria-label="Step ${n} name" value="${esc(s.name)}" placeholder="Step name">
        <textarea class="field desc" data-f="desc" id="d${s.id}" rows="1" aria-label="Step ${n} notes" placeholder="Add notes (optional)">${esc(s.desc)}</textarea>
      </div>
      <div class="side">
        <div class="dur"><label for="du${s.id}">Time</label>
          <input id="du${s.id}" data-f="dur" type="number" min="0" step="any" inputmode="decimal" value="${esc(s.dur)}">
          <select id="un${s.id}" data-f="unit" aria-label="Duration unit">${units}</select></div>
        <div class="actions">
          <button class="icon br" data-a="branch" type="button" title="Start another chain from this step" aria-label="Branch from step ${n}">${BRANCH_SVG}Branch</button>
          <button class="icon" data-a="up" type="button" title="Move up" aria-label="Move step ${n} up">↑</button>
          <button class="icon" data-a="down" type="button" title="Move down" aria-label="Move step ${n} down">↓</button>
          <button class="icon" data-a="dup" type="button" title="Duplicate" aria-label="Duplicate step ${n}">⧉</button>
          <button class="icon del" data-a="del" type="button" title="Delete" aria-label="Delete step ${n}">✕</button>
        </div>
      </div>
      ${row}
    </section></div>`;
  }

  function rejoinOptions(sp, seq, i) {
    const A = sp.branches[0], cont = sp.merge ? seq.slice(i + 1) : [];
    const L = A.concat(cont);
    let cur = !sp.merge ? "none" : (cont.length ? String(A.length) : "end");
    const label = it => isSplit(it) ? "the next split" : `${nums[it.id]}. ${it.name || "Untitled"}`;
    let o = `<option value="none"${cur === "none" ? " selected" : ""}>Don't rejoin</option>`;
    L.forEach((it, k) => { o += `<option value="${k}"${cur === String(k) ? " selected" : ""}>Rejoin before ${esc(label(it))}</option>`; });
    o += `<option value="end"${cur === "end" ? " selected" : ""}>Rejoin after all chains end</option>`;
    return o;
  }

  function splitHtml(sp, seq, i) {
    const cols = sp.branches.map((b, bi) => `<div class="col" data-split="${sp.id}" data-bi="${bi}">
        <div class="stem"></div>
        <div class="colhead"><input data-f="label" aria-label="Chain ${letter(bi)} label" value="${esc(sp.labels[bi] || "Path " + letter(bi))}">
          <button class="icon del" data-a="delchain" type="button" title="Delete this chain and its steps" aria-label="Delete chain ${letter(bi)}">✕</button></div>
        <div class="arrowstem"></div>
        ${b.length ? `<div class="seq">${seqHtml(b)}</div>` : `<div class="direct">Direct path (no steps)</div>`}
        <div class="tail">${b.length && isSplit(b[b.length - 1]) && !b[b.length - 1].merge ? "" : `<button class="addend" data-a="addend" type="button">+ Step in this chain</button>`}</div>
      </div>`).join("");
    return `<div class="split${sp.merge ? " merged" : ""}" data-split="${sp.id}">
      <div class="splitbar"><b>Split</b>
        <label class="sr" for="rj${sp.id}" style="position:absolute;left:-9999px">Where the chains rejoin</label>
        <select id="rj${sp.id}" data-f="rejoin">${rejoinOptions(sp, seq, i)}</select>
        <button class="btn" data-a="addchain" type="button">+ Add chain</button></div>
      <div class="stem"></div>
      <div class="branches">${cols}</div>
      ${sp.merge ? '<div class="joined"></div>' : ""}
    </div>`;
  }
  function autosize(el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
  function focusField(id, f) { const el = flow.querySelector(`.node[data-id="${id}"] [data-f="${f}"]`); if (el) el.focus(); }
  const newStep = () => mk("step", "", "", 30, "min");

  // ---------- Editing ----------
  flow.addEventListener("change", e => {
    const g = e.target.dataset.g;
    if (!g) return;
    state[g] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    save(); refreshTimes();
  });
  flow.addEventListener("input", e => {
    if (e.target.dataset.g && e.target.type !== "checkbox") { state[e.target.dataset.g] = e.target.value; save(); refreshTimes(); return; }
    const f = e.target.dataset.f;
    if (!f) return;
    const col = e.target.closest(".col"), node = e.target.closest(".node");
    if (f === "label" && col) { const sp = locate(+col.dataset.split).item; sp.labels[+col.dataset.bi] = e.target.value; save(); return; }
    if (!node) return;
    const s = locate(+node.dataset.id).item;
    if (f === "type" || f === "unit" || f === "noTarget" || f === "rejoin") return;
    s[f] = e.target.value;
    if (e.target.tagName === "TEXTAREA") autosize(e.target);
    if (f === "dur") refreshTimes();
    if (f === "name") flow.querySelectorAll(`select[data-f="noTarget"] option[value="${s.id}"]`).forEach(o => o.textContent = `${nums[s.id]}. ${s.name || "Untitled"}`);
    if (f === "yes") { const c = node.closest(".item").nextElementSibling; const l = c && c.querySelector(".yes"); if (l) l.textContent = s.yes; }
    save();
  });
  flow.addEventListener("change", e => {
    const f = e.target.dataset.f;
    if (f === "rejoin") { applyRejoin(+e.target.closest(".split").dataset.split, e.target.value); return; }
    const node = e.target.closest(".node");
    if (!f || !node) return;
    const s = locate(+node.dataset.id).item;
    if (f === "type") { s.type = e.target.value; if (s.type === "decision" && !s.yes) { s.yes = "Yes"; s.no = "No"; s.noTarget = null; } save(); render(); focusField(s.id, "type"); }
    else if (f === "unit") { s.unit = e.target.value; refreshTimes(); save(); }
    else if (f === "noTarget") { s.noTarget = e.target.value ? +e.target.value : null; save(); }
  });

  function applyRejoin(splitId, v) {
    const { seq, i, item: sp } = locate(splitId);
    const A = sp.branches[0];
    const cont = sp.merge ? seq.splice(i + 1) : [];
    const L = A.concat(cont);
    if (v === "none") { sp.branches[0] = L; sp.merge = false; }
    else if (v === "end") { sp.branches[0] = L; sp.merge = true; }
    else { const k = +v; sp.branches[0] = L.slice(0, k); sp.merge = true; seq.push(...L.slice(k)); }
    save(); render();
    const sel = flow.querySelector(`#rj${splitId}`); if (sel) sel.focus();
  }

  function branchFrom(id) {
    const { seq, i, item } = locate(id);
    if (isSplit(seq[i + 1])) { // already splits here: add a chain to that split
      const sp = seq[i + 1]; const ns = newStep();
      sp.branches.push([ns]); sp.labels.push("Path " + letter(sp.branches.length - 1));
      return ns.id;
    }
    const rest = seq.splice(i + 1);
    const nsB = newStep();
    const A = rest.length ? rest : [newStep()];
    const labels = item.type === "decision" ? [item.yes || "Yes", item.no || "No"] : ["Path A", "Path B"];
    if (item.type === "decision") item.noTarget = null;
    seq.push(mkSplit(labels, [A, [nsB]], false));
    return nsB.id;
  }

  function removeChain(splitId, bi) {
    const { seq, i, item: sp } = locate(splitId);
    const gone = sp.branches[bi];
    sp.branches.splice(bi, 1); sp.labels.splice(bi, 1);
    const goneIds = []; walk(gone, it => goneIds.push(it.id));
    walk(state.items, it => { if (goneIds.includes(it.noTarget)) it.noTarget = null; });
    if (sp.branches.length === 1) seq.splice(i, 1, ...sp.branches[0]);
  }

  flow.addEventListener("click", e => {
    const b = e.target.closest("button[data-a]");
    if (!b) return;
    const a = b.dataset.a;
    if (a === "ins") { const r = locate(+b.dataset.after); const n = newStep(); r.seq.splice(r.i + 1, 0, n); save(); render(); focusField(n.id, "name"); return; }
    if (a === "addend") { const col = b.closest(".col"); const sp = locate(+col.dataset.split).item; const n = newStep(); sp.branches[+col.dataset.bi].push(n); save(); render(); focusField(n.id, "name"); return; }
    if (a === "addchain") { const sp = locate(+b.closest(".split").dataset.split).item; const n = newStep(); sp.branches.push([n]); sp.labels.push("Path " + letter(sp.branches.length - 1)); save(); render(); focusField(n.id, "name"); return; }
    if (a === "delchain") { const col = b.closest(".col"); pendingChain = { split: +col.dataset.split, bi: +col.dataset.bi }; openDialog("Delete this chain and every step in it?", "Delete chain"); return; }
    const id = +b.closest(".node").dataset.id;
    const { seq, i, item } = locate(id);
    if (a === "branch") { const nid = branchFrom(id); save(); render(); focusField(nid, "name"); toast("Added a chain. Use the Split menu to choose where the chains rejoin."); return; }
    if (a === "up") {
      if (i === 0) { toast("This is already the first step in its chain."); return; }
      [seq[i - 1], seq[i]] = [seq[i], seq[i - 1]];
    } else if (a === "down") {
      if (i >= seq.length - 1) { toast("This is already the last step in its chain."); return; }
      if (isSplit(seq[i + 1]) && !seq[i + 1].merge) { toast("Set this split to rejoin before moving a step below it."); return; }
      [seq[i + 1], seq[i]] = [seq[i], seq[i + 1]];
    } else if (a === "dup") seq.splice(i + 1, 0, Object.assign({}, item, { id: uid++ }));
    else if (a === "del") { seq.splice(i, 1); walk(state.items, it => { if (it.noTarget === id) it.noTarget = null; }); }
    else return;
    save(); render();
    const again = flow.querySelector(`.node[data-id="${id}"] button[data-a="${a}"]`); if (again) again.focus();
  });

  document.getElementById("chartTitle").addEventListener("input", e => { state.title = e.target.value; save(); });
  function addAtEnd() {
    let seq = state.items;
    while (seq.length && isSplit(seq[seq.length - 1]) && !seq[seq.length - 1].merge) seq = seq[seq.length - 1].branches[0];
    const n = newStep();
    const last = seq[seq.length - 1];
    if (last && !isSplit(last) && last.type === "end") seq.splice(seq.length - 1, 0, n); else seq.push(n);
    return n;
  }
  function showNew(n) {
    save(); render(); picked = n.id; markPicked();
    const el = flow.querySelector(`.node[data-id="${n.id}"]`);
    if (el) { el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }
    focusField(n.id, "name");
  }
  document.getElementById("addEnd").addEventListener("click", () => { picked = null; showNew(addAtEnd()); });

  // Floating add button: inserts after the step you last clicked into, or at the end.
  let picked = null;
  const fabWhere = document.getElementById("fabWhere");
  function markPicked() {
    flow.querySelectorAll(".node.picked").forEach(el => el.classList.remove("picked"));
    const r = picked != null && locate(picked);
    if (!r) { picked = null; fabWhere.textContent = "Adds at the end"; return; }
    const el = flow.querySelector(`.node[data-id="${picked}"]`); if (el) el.classList.add("picked");
    const s = r.item, nm = s.name ? (s.name.length > 28 ? s.name.slice(0, 27) + "…" : s.name) : "Untitled";
    fabWhere.textContent = s.type === "end" && r.i === r.seq.length - 1 ? `Adds before ${nm}` : `Adds after ${String(nums[s.id]).padStart(2, "0")}. ${nm}`;
  }
  flow.addEventListener("focusin", e => { const node = e.target.closest(".node"); if (node && +node.dataset.id !== picked) { picked = +node.dataset.id; markPicked(); } });
  flow.addEventListener("pointerdown", e => { const node = e.target.closest(".node"); if (node && +node.dataset.id !== picked) { picked = +node.dataset.id; markPicked(); } });
  document.getElementById("fabAdd").addEventListener("click", () => {
    const r = picked != null && locate(picked);
    if (!r) { showNew(addAtEnd()); return; }
    const n = newStep();
    const after = r.item.type === "end" && r.i === r.seq.length - 1 ? r.i : r.i + 1; // never add below an End step
    r.seq.splice(after, 0, n);
    showNew(n);
  });

  const toast = (msg, err) => { const t = document.getElementById("toast"); t.textContent = msg; t.classList.toggle("err", !!err); clearTimeout(toast.h); toast.h = setTimeout(() => t.textContent = "", 4500); };

  // ---------- Copy as text ----------
  document.getElementById("copyText").addEventListener("click", async () => {
    times = {}; const total = computeTimes(state.items, 0, times); nums = numbering(state.items).map;
    const lines = [state.title, "Longest path: " + fmt(total)];
    const pr = projection(total);
    if (pr) {
      lines.push(`Start: ${fmtDate(pr.start, true)}, ${fmtTime(pr.start)}`);
      lines.push(`Projected completion: ${fmtDate(pr.late, true)}, ${fmtTime(pr.late)}` + (pr.early.getTime() !== pr.late.getTime() ? ` (window ${fmtDate(pr.early)} - ${fmtDate(pr.late)})` : ""));
      lines.push(`Working calendar: 8-hour days from ${state.startTime}` + (state.skipWeekends ? ", weekdays only" : ", including weekends"));
    }
    lines.push("");
    const out = (items, ind) => items.forEach((it, i) => {
      if (isSplit(it)) {
        lines.push(`${ind}Split into ${it.branches.length} chains:`);
        it.branches.forEach((b, bi) => { lines.push(`${ind}  Chain ${letter(bi)} (${it.labels[bi] || "Path " + letter(bi)}):`); if (b.length) out(b, ind + "    "); else lines.push(ind + "    (direct path)"); });
        lines.push(ind + (it.merge ? "Chains rejoin here." : "Chains do not rejoin."));
      } else {
        let line = `${ind}${nums[it.id]}. [${TYPES[it.type]}] ${it.name || "Untitled"} (${it.dur || 0} ${UNIT_LABEL[it.unit]}; starts +${fmt(times[it.id])})`;
        if (it.desc) line += `\n${ind}   ${it.desc}`;
        if (it.type === "decision" && !isSplit(items[i + 1]) && it.noTarget) { const r = locate(it.noTarget); if (r) line += `\n${ind}   ${it.yes || "Yes"} -> next step; ${it.no || "No"} -> step ${nums[it.noTarget]}`; }
        lines.push(line);
      }
    });
    out(state.items, "");
    try { await navigator.clipboard.writeText(lines.join("\n")); toast("Copied to clipboard"); }
    catch (e) { toast("Copy was blocked by the browser", true); }
  });

  // ---------- Dialog ----------
  const dlg = document.getElementById("dlg");
  let pendingChain = null;
  function openDialog(text, yes) { document.getElementById("dlgText").textContent = text; document.getElementById("dlgYes").textContent = yes; dlg.classList.add("open"); document.getElementById("dlgNo").focus(); }
  document.getElementById("dlgNo").addEventListener("click", () => dlg.classList.remove("open"));
  document.getElementById("dlgYes").addEventListener("click", () => {
    dlg.classList.remove("open");
    if (pendingChain) { removeChain(pendingChain.split, pendingChain.bi); pendingChain = null; save(); render(); toast("Chain deleted"); }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") dlg.classList.remove("open"); });

  // ---------- Fillable PDF export ----------
  let downloadsP = null;
  try { if (window.claude && claude.use) downloadsP = Promise.race([claude.use("downloads"), new Promise(r => setTimeout(() => r(null), 1500))]); } catch (e) {}

  // Standard PDF fonts only cover Latin-1; swap common symbols and drop the rest.
  const pdfSafe = s => String(s == null ? "" : s)
    .replace(/[→⇒]/g, "->").replace(/[←]/g, "<-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");

  async function buildPdf(includeBlanks) {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    doc.setTitle(pdfSafe(state.title) || "Flowchart");
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const form = doc.getForm();
    const hex = h => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
    const tint = (c, t) => rgb(c.red + (1 - c.red) * t, c.green + (1 - c.green) * t, c.blue + (1 - c.blue) * t);
    const rrect = (w, h, r) => `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z`;
    const boldFields = [];
    const C = { ink: hex("#18212b"), muted: hex("#5d6b7a"), line: hex("#d3dbe3"), conn: hex("#98a6b5"), field: hex("#f2f5f8"), shadow: hex("#e4e9ef"),
      step: hex("#1f6feb"), start: hex("#1a7f5a"), decision: hex("#b7791f"), wait: hex("#7c5cc4"), end: hex("#b42318") };

    // Work on a copy so blank slots don't touch the page.
    const items = JSON.parse(JSON.stringify(state.items));
    if (includeBlanks) {
      let seq = items;
      while (seq.length && isSplit(seq[seq.length - 1]) && !seq[seq.length - 1].merge) seq = seq[seq.length - 1].branches[0];
      const blanks = [0, 1, 2].map(k => ({ kind: "step", id: "blank" + k, blank: true, type: "step", name: "", desc: "", dur: "", unit: "min" }));
      const last = seq[seq.length - 1];
      if (last && !isSplit(last) && last.type === "end") seq.splice(seq.length - 1, 0, ...blanks); else seq.push(...blanks);
    }
    const st = {}; const total = computeTimes(items, 0, st);
    const { map: num, list: allSteps } = numbering(items);

    const M = 40, GAP = 22, GAPX = 14, MINBOX = 196, FORK = 40, JOIN = 14, DIRECT = 26;
    const minW = seq => Math.max(MINBOX, ...seq.map(it => isSplit(it) ? it.branches.reduce((a, b) => a + minW(b), 0) + GAPX * (it.branches.length - 1) : MINBOX));
    const hasTarget = (seq, i) => seq[i].type === "decision" && !isSplit(seq[i + 1]) && seq[i].noTarget != null;
    const boxH = (w, target) => (w >= 400 ? 78 : 104) + (target ? 18 : 0);
    const bw = (w, n) => (w - GAPX * (n - 1)) / n;
    function itemH(seq, i, w) {
      const it = seq[i];
      if (!isSplit(it)) return boxH(w, hasTarget(seq, i));
      const b = bw(w, it.branches.length);
      return FORK + Math.max(...it.branches.map(br => seqH(br, b))) + (it.merge ? JOIN : 0);
    }
    function seqH(seq, w) { if (!seq.length) return DIRECT; let h = 0; seq.forEach((_, i) => { h += itemH(seq, i, w) + (i ? GAP : 0); }); return h; }

    const contentW = Math.max(612 - 2 * M, minW(items));
    const W = contentW + 2 * M, BASE_H = 792, HEADER = 136;

    // Pack top-level blocks onto pages.
    const pagesPlan = []; let cur = { blocks: [], h: 0 };
    const avail = first => BASE_H - 2 * M - 24 - (first ? HEADER : 28);
    items.forEach((_, i) => {
      const h = itemH(items, i, contentW);
      const need = cur.blocks.length ? h + GAP : h;
      if (cur.blocks.length && cur.h + need > avail(pagesPlan.length === 0)) { pagesPlan.push(cur); cur = { blocks: [], h: 0 }; }
      cur.blocks.push(i); cur.h += cur.blocks.length > 1 ? h + GAP : h;
    });
    pagesPlan.push(cur);

    const units = Object.keys(UNITS).map(k => UNIT_LABEL[k]);
    const typeNames = Object.values(TYPES);
    let splitCount = 0;

    for (let p = 0; p < pagesPlan.length; p++) {
      const plan = pagesPlan[p];
      const H = Math.max(BASE_H, plan.h + 2 * M + 24 + (p === 0 ? HEADER : 28));
      const page = doc.addPage([W, H]);
      const Y = y => H - y; // top-down helper
      const fo = (x, y, w, h, extra) => Object.assign({ x, y: Y(y + h), width: w, height: h, borderWidth: 0, backgroundColor: C.field, textColor: C.ink }, extra || {});
      const text = (str, x, y, size, f, color) => page.drawText(pdfSafe(str), { x, y: Y(y), size, font: f || font, color: color || C.muted });
      const vline = (x, y1, y2) => page.drawLine({ start: { x, y: Y(y1) }, end: { x, y: Y(y2) }, thickness: 1.2, color: C.conn });
      const hline = (x1, x2, y) => page.drawLine({ start: { x: x1, y: Y(y) }, end: { x: x2, y: Y(y) }, thickness: 1.2, color: C.conn });
      const arrow = (x, yTip) => page.drawSvgPath("M -5 -8 L 5 -8 L 0 0 Z", { x, y: Y(yTip), color: C.conn });

      let y = M;
      page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: C.step });
      if (p === 0) {
        text("FLOWCHART", M, y + 12, 8, bold, C.step);
        const tf = form.createTextField("chart_title"); tf.setText(pdfSafe(state.title));
        tf.addToPage(page, fo(M - 3, y + 17, contentW + 6, 30, { backgroundColor: rgb(1, 1, 1) })); tf.setFontSize(20); boldFields.push(tf);
        page.drawRectangle({ x: M, y: Y(y + 54), width: 36, height: 2.5, color: C.step });
        // Summary cards
        const pr = (() => { const s0 = startMoment(); if (!s0) return null; const cal = calendar(); return { start: cal.add(s0, 0, true), late: cal.add(s0, total), early: cal.add(s0, computeMin(items, 0)) }; })();
        const cards = [
          ["START", "start_date", pr ? fmtDate(pr.start, true) + ", " + fmtTime(pr.start) : "", false],
          ["PROJECTED COMPLETION", "projected_completion", pr ? fmtDate(pr.late, true) + ", " + fmtTime(pr.late) : "", true],
          ["COMPLETION WINDOW", "completion_window", pr ? (pr.early.getTime() === pr.late.getTime() ? fmtDate(pr.late) : fmtDate(pr.early) + " - " + fmtDate(pr.late)) : "", false],
          ["LONGEST PATH", "total_time", fmt(total), false]
        ];
        const cw = (contentW - 30) / 4, cy = y + 64, ch = 46;
        cards.forEach(([label, fname, val, hi], k) => {
          const x = M + k * (cw + 10);
          page.drawSvgPath(rrect(cw, ch, 7), { x, y: Y(cy), color: hi ? tint(C.step, 0.92) : rgb(1, 1, 1), borderColor: hi ? C.step : C.line, borderWidth: hi ? 1.1 : 0.8 });
          text(label, x + 9, cy + 15, 6.5, bold, hi ? C.step : C.muted);
          const f = form.createTextField(fname); f.setText(pdfSafe(val));
          f.addToPage(page, fo(x + 6, cy + 20, cw - 12, 20, { backgroundColor: hi ? tint(C.step, 0.92) : rgb(1, 1, 1) })); f.setFontSize(9.5); boldFields.push(f);
        });
        text("Every box can be typed into. Dates were worked out at export from 8-hour workdays starting " + (state.startTime || "09:00") + (state.skipWeekends ? ", weekdays only" : ", weekends included") + ". Update them if you change a duration.", M, cy + ch + 14, 7);
        y += HEADER;
      } else { text(pdfSafe(state.title), M, y + 14, 11, bold, C.ink); text("continued", M + bold.widthOfTextAtSize(pdfSafe(state.title), 11) + 8, y + 14, 8, font, C.muted); y += 28; }

      function drawBox(s, x, y0, w, target) {
        const n = num[s.id], color = C[s.type] || C.step, h = boxH(w, target), wide = w >= 400;
        const round = s.type === "start" || s.type === "end";
        const r = round ? 18 : 8, band = wide ? 30 : 24, i = 1.2;
        // Soft shadow, coloured card, white panel leaving a coloured band on the left
        page.drawSvgPath(rrect(w, h, r), { x, y: Y(y0 + 2), color: C.shadow });
        page.drawSvgPath(rrect(w, h, r), { x, y: Y(y0), color });
        page.drawSvgPath(`M ${band} ${i} L ${w - r} ${i} Q ${w - i} ${i} ${w - i} ${r} L ${w - i} ${h - r} Q ${w - i} ${h - i} ${w - r} ${h - i} L ${band} ${h - i} Z`, { x, y: Y(y0), color: rgb(1, 1, 1) });
        const isDec = s.type === "decision", ns = String(n), nsz = isDec ? (wide ? 9 : 8) : (wide ? 12 : 10);
        const bcx = x + band / 2 + (round ? 1.5 : 0.5), bcy = y0 + h / 2;
        if (isDec) { const d = wide ? 11.5 : 9.5; page.drawSvgPath(`M 0 ${-d} L ${d} 0 L 0 ${d} L ${-d} 0 Z`, { x: bcx, y: Y(bcy), borderColor: rgb(1, 1, 1), borderWidth: 1 }); }
        page.drawText(ns, { x: bcx - bold.widthOfTextAtSize(ns, nsz) / 2, y: Y(bcy + nsz * 0.36), size: nsz, font: bold, color: rgb(1, 1, 1) });

        const L = x + band + 10, innerR = x + w - (round ? 14 : 10);
        const tF = form.createDropdown(`step${n}_type`); tF.addOptions(typeNames); tF.select(TYPES[s.type] || "Step");
        tF.addToPage(page, fo(L, y0 + 7, wide ? 66 : 58, 14, { textColor: color, backgroundColor: tint(color, 0.88) })); tF.setFontSize(7.5);
        const startTxt = s.blank ? "" : "+" + fmt(st[s.id] || 0);
        const durTxt = s.dur === "" || s.dur == null ? "" : pdfSafe(s.dur);
        if (wide) {
          const R = innerR - 124, fw = R - 12 - L;
          const nF = form.createTextField(`step${n}_name`); nF.setText(pdfSafe(s.name)); nF.addToPage(page, fo(L, y0 + 26, fw, 18)); nF.setFontSize(10.5); boldFields.push(nF);
          const dF = form.createTextField(`step${n}_notes`); dF.enableMultiline(); dF.setText(pdfSafe(s.desc)); dF.addToPage(page, fo(L, y0 + 48, fw, 22)); dF.setFontSize(8);
          text("DURATION", R, y0 + 17, 6.5, bold);
          const du = form.createTextField(`step${n}_duration`); du.setText(durTxt); du.addToPage(page, fo(R, y0 + 22, 62, 20)); du.setFontSize(11);
          const un = form.createDropdown(`step${n}_unit`); un.addOptions(units); un.select(UNIT_LABEL[s.unit] || "min"); un.addToPage(page, fo(R + 66, y0 + 22, 58, 20)); un.setFontSize(9);
          text("STARTS", R, y0 + 58, 6.5, bold);
          const sF = form.createTextField(`step${n}_starts`); sF.setText(startTxt); sF.addToPage(page, fo(R + 34, y0 + 48, 90, 14)); sF.setFontSize(8);
        } else {
          const fw = innerR - L;
          text("STARTS", L + 64, y0 + 16.5, 6, bold);
          const sF = form.createTextField(`step${n}_starts`); sF.setText(startTxt); sF.addToPage(page, fo(L + 90, y0 + 7, fw - 90, 14)); sF.setFontSize(7.5);
          const nF = form.createTextField(`step${n}_name`); nF.setText(pdfSafe(s.name)); nF.addToPage(page, fo(L, y0 + 26, fw, 18)); nF.setFontSize(9.5); boldFields.push(nF);
          const dF = form.createTextField(`step${n}_notes`); dF.enableMultiline(); dF.setText(pdfSafe(s.desc)); dF.addToPage(page, fo(L, y0 + 48, fw, 22)); dF.setFontSize(7.5);
          text("DURATION", L, y0 + 87, 6, bold);
          const du = form.createTextField(`step${n}_duration`); du.setText(durTxt); du.addToPage(page, fo(L + 40, y0 + 75, 46, 18)); du.setFontSize(10);
          const un = form.createDropdown(`step${n}_unit`); un.addOptions(units); un.select(UNIT_LABEL[s.unit] || "min"); un.addToPage(page, fo(L + 90, y0 + 75, 50, 18)); un.setFontSize(8.5);
        }
        if (target) {
          const t = allSteps.find(z => z.id === s.noTarget);
          const ty = y0 + h - 22;
          text("IF " + pdfSafe(s.no || "No").toUpperCase().slice(0, 12) + ", GO TO", L, ty + 10, 6.5, bold, C.decision);
          const bF = form.createTextField(`step${n}_branch`); bF.setText(t ? "Step " + num[t.id] + ": " + pdfSafe(t.name) : "");
          bF.addToPage(page, fo(L + 70, ty, innerR - L - 70, 14)); bF.setFontSize(7.5);
        }
        return h;
      }

      function drawSeq(seq, x, y0, w) {
        let yy = y0;
        seq.forEach((it, i) => {
          const h = drawItem(seq, i, x, yy, w);
          yy += h;
          if (i < seq.length - 1) {
            const cx = x + w / 2;
            vline(cx, yy, yy + GAP - (isSplit(seq[i + 1]) ? 0 : 2));
            if (!isSplit(seq[i + 1])) arrow(cx, yy + GAP);
            if (!isSplit(it) && it.type === "decision" && !isSplit(seq[i + 1])) text(pdfSafe(it.yes || "Yes").toUpperCase(), cx + 8, yy + 13, 7, bold, C.decision);
            yy += GAP;
          }
        });
        return yy;
      }

      function drawItem(seq, i, x, y0, w) {
        const it = seq[i];
        if (!isSplit(it)) return drawBox(it, x, y0, w, hasTarget(seq, i));
        const sIdx = ++splitCount, n = it.branches.length, b = bw(w, n), cx = x + w / 2;
        const centers = it.branches.map((_, k) => x + k * (b + GAPX) + b / 2);
        const total = itemH(seq, i, w), bodyTop = y0 + FORK, joinY = y0 + total - (it.merge ? 4 : 0);
        vline(cx, y0, y0 + 6);
        hline(centers[0], centers[n - 1], y0 + 6);
        it.branches.forEach((br, k) => {
          const c = centers[k];
          vline(c, y0 + 6, y0 + 12);
          const lw = Math.min(90, b - 10);
          const lf = form.createTextField(`split${sIdx}_chain${k + 1}_label`); lf.setText(pdfSafe(it.labels[k] || "Path " + letter(k)).toUpperCase());
          page.drawSvgPath(rrect(lw, 13, 6.5), { x: c - lw / 2, y: Y(y0 + 11.5), color: rgb(1, 1, 1), borderColor: C.conn, borderWidth: 0.8 });
          lf.addToPage(page, fo(c - lw / 2 + 5, y0 + 12, lw - 10, 12, { textColor: C.muted, backgroundColor: rgb(1, 1, 1) })); lf.setFontSize(7); lf.setAlignment(1); boldFields.push(lf);
          vline(c, y0 + 24, y0 + FORK - 2); arrow(c, y0 + FORK);
          let end;
          if (br.length) end = drawSeq(br, c - b / 2, bodyTop, b);
          else { text("(direct path)", c - 22, bodyTop + 14, 7, font); end = bodyTop + DIRECT; }
          if (it.merge) vline(c, br.length ? end : bodyTop + 18, joinY);
        });
        if (it.merge) { hline(centers[0], centers[n - 1], joinY); vline(cx, joinY, y0 + total); }
        return total;
      }

      plan.blocks.forEach((bi, k) => {
        const h = drawItem(items, bi, M, y, contentW);
        y += h;
        const isLast = bi === items.length - 1;
        if (!isLast) {
          const cx = M + contentW / 2;
          if (k === plan.blocks.length - 1) text("continued on next page", cx - 40, y + 14, 7.5);
          else {
            const nx = items[bi + 1];
            vline(cx, y, y + GAP - (isSplit(nx) ? 0 : 2));
            if (!isSplit(nx)) arrow(cx, y + GAP);
            const it = items[bi];
            if (!isSplit(it) && it.type === "decision" && !isSplit(nx)) text(pdfSafe(it.yes || "Yes").toUpperCase(), cx + 8, y + 13, 7, bold, C.decision);
            y += GAP;
          }
        }
      });
      // Footer: legend and page number
      page.drawLine({ start: { x: M, y: 38 }, end: { x: W - M, y: 38 }, thickness: 0.6, color: C.line });
      let lx = M;
      Object.keys(TYPES).forEach(k => {
        page.drawCircle({ x: lx + 3, y: 26.5, size: 3, color: C[k] });
        text(TYPES[k], lx + 10, H - 24, 7);
        lx += 10 + font.widthOfTextAtSize(TYPES[k], 7) + 14;
      });
      const pn = `Page ${p + 1} of ${pagesPlan.length}`;
      text(pn, W - M - font.widthOfTextAtSize(pn, 7), H - 24, 7);
    }
    form.updateFieldAppearances(font);
    boldFields.forEach(fl => fl.updateAppearances(bold));
    return doc.save();
  }

  document.getElementById("exportPdf").addEventListener("click", async e => {
    const btn = e.currentTarget;
    if (typeof PDFLib === "undefined") { toast("The PDF tool didn't load. Reload the page and try again.", true); return; }
    btn.disabled = true; btn.textContent = "Building PDF…";
    try {
      const downloads = downloadsP ? await downloadsP.catch(() => null) : null;
      // Outside claude.ai (e.g. GitHub Pages) fall back to a normal browser download.
      const plainSave = ({ filename, data }) => {
        const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
        const a = document.createElement("a"); a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return Promise.resolve({ status: "saved" });
      };
      const saver = downloads ? downloads.save : plainSave;
      const bytes = await buildPdf(document.getElementById("blankSlots").checked);
      const name = (pdfSafe(state.title).trim().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-") || "flowchart") + ".pdf";
      await saver({ filename: name, data: new Blob([bytes]) });
      toast("PDF saved");
    } catch (err) {
      const code = err && err.code;
      if (code === "declined") toast("Export cancelled");
      else if (code === "rate_limited") toast("A save prompt is already open. Try again in a moment.", true);
      else if (code && code !== "bad_request") toast("Saving files isn't available here.", true);
      else { console.error(err); toast("Couldn't build the PDF: " + (err && err.message || err), true); }
    } finally { btn.disabled = false; btn.textContent = "Export fillable PDF"; }
  });

  // ---------- Public API used by app.js ----------
  window.FlowEditor = {
    load(data, opts) {
      const d = JSON.parse(JSON.stringify(data || {}));
      if (!Array.isArray(d.items)) d.items = [];
      if (!d.title) d.title = "Untitled flowchart";
      state = withDefaults(d);
      uid = maxId(state.items) + 1;
      readOnly = !!(opts && opts.readOnly);
      document.body.classList.toggle("readonly", readOnly);
      picked = null;
      render();
    },
    getData() { return JSON.parse(JSON.stringify(state)); },
    onChange(cb) { changeCbs.push(cb); },
    example() { uid = 1; return withDefaults({ title: "New Customer Onboarding", items: template() }); },
    blank() {
      uid = 1;
      return withDefaults({ title: "Untitled flowchart", items: [
        mk("start", "Start", "", 0, "min"), mk("step", "First step", "", 30, "min"), mk("end", "Finish", "", 0, "min")] });
    },
    toast,
    // test hooks
    _internals: { buildPdf, branchFrom, applyRejoin, removeChain, locate, get state() { return state; } }
  };
})();
