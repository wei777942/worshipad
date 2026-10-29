(function () {
  "use strict";

  const STORE_KEY = "pad-live-setlists-v1";
  const MODE_KEY = "pad-live-mode-v1";

  function uid() {
    return "s" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function defaultStore() {
    const sid = uid();
    return {
      version: 1,
      activeSetlistId: sid,
      setlists: [{ id: sid, name: "List 1", songs: [], activeSongId: null }],
    };
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultStore();
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.setlists) || !parsed.setlists.length) return defaultStore();
      parsed.setlists.forEach(function (sl) {
        if (!Array.isArray(sl.songs)) sl.songs = [];
        if (!sl.id) sl.id = uid();
        if (!sl.name) sl.name = "List";
      });
      if (!parsed.activeSetlistId || !parsed.setlists.some(function (s) { return s.id === parsed.activeSetlistId; })) {
        parsed.activeSetlistId = parsed.setlists[0].id;
      }
      return parsed;
    } catch (e) {
      return defaultStore();
    }
  }

  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {}
  }

  function activeSetlist() {
    return store.setlists.find(function (s) { return s.id === store.activeSetlistId; }) || store.setlists[0];
  }

  function normalizeSong(raw) {
    const notes = (window.__padApp && window.__padApp.getNotes()) || [{ id: "C" }];
    const timbres = (window.__padApp && window.__padApp.getTimbres()) || [{ id: "pad" }];
    const keyOk = notes.some(function (n) { return n.id === raw.key; });
    const timOk = timbres.some(function (t) { return t.id === raw.timbre; });
    const song = {
      id: raw.id || uid(),
      name: String(raw.name || "Chord").slice(0, 64),
      key: keyOk ? raw.key : "C",
      timbre: timOk ? raw.timbre : "pad",
      bpm: Math.max(40, Math.min(220, Number(raw.bpm) || 100)),
      timeSig: ["2/4", "3/4", "4/4", "6/8"].indexOf(raw.timeSig) >= 0 ? raw.timeSig : "4/4",
      metro: raw.metro === true || raw.metro === 1 || raw.metro === "1" || raw.metro === "true",
    };
    if (raw.hipass != null && raw.lopass != null) {
      song.hipass = Math.max(20, Math.min(1000, Number(raw.hipass)));
      song.lopass = Math.max(500, Math.min(20000, Number(raw.lopass)));
    }
    if (raw.reverb != null) song.reverb = Math.max(0, Math.min(1, Number(raw.reverb)));
    if (raw.volume != null) song.volume = Math.max(0, Math.min(1, Number(raw.volume)));
    return song;
  }

  let store = loadStore();
  let mode = localStorage.getItem(MODE_KEY) === "setlist" ? "setlist" : "live";
  let editSongId = null;
  let dragId = null;
  let previewSession = null; // { snapshot }
  let renameTimer = null;
  let lastTap = { id: null, t: 0 };

  const els = {
    tabs: document.getElementById("mode-tabs"),
    panel: document.getElementById("setlist-panel"),
    tabsRow: document.getElementById("setlist-tabs"),
    list: document.getElementById("song-list"),
    hint: document.getElementById("setlist-hint"),
    modal: document.getElementById("song-modal"),
  };



  const ICO = {
    up: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    edit: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3zM13 6l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    del: '<svg class="ico ico-trash" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 7l.8 12.2A1.5 1.5 0 0 0 9.3 20.5h5.4a1.5 1.5 0 0 0 1.5-1.3L17 7" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function t(key, fallback) {
    const i18n = (window.__padI18n || {});
    return i18n[key] != null ? i18n[key] : (fallback != null ? fallback : key);
  }

  function appConfirm(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      const modal = document.getElementById("app-confirm");
      const msg = document.getElementById("app-confirm-msg");
      const title = document.getElementById("app-confirm-title");
      const okBtn = document.getElementById("app-confirm-ok");
      const cancelBtn = document.getElementById("app-confirm-cancel");
      if (!modal || !msg || !okBtn) {
        resolve(false);
        return;
      }
      title.textContent = opts.title || t("confirmTitle", "Delete?");
      msg.textContent = message;
      okBtn.setAttribute("aria-label", opts.okLabel || t("confirmOk", "Yes"));
      cancelBtn.hidden = !!opts.alertOnly;
      cancelBtn.setAttribute("aria-label", opts.cancelLabel || t("cancel", "No"));
      if (opts.danger) okBtn.classList.add("danger-confirm");
      else okBtn.classList.remove("danger-confirm");

      function cleanup(result) {
        modal.hidden = true;
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        modal.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKey);
        resolve(result);
      }
      function onOk(e) { e.preventDefault(); cleanup(true); }
      function onCancel(e) { e.preventDefault(); cleanup(false); }
      function onBackdrop(e) {
        if (e.target === modal) cleanup(false);
      }
      function onKey(e) {
        if (e.key === "Escape") cleanup(false);
        if (e.key === "Enter") cleanup(true);
      }
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      modal.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKey);
      modal.hidden = false;
      try { okBtn.focus(); } catch (err) {}
    });
  }

  function appAlert(message) {
    return appConfirm(message, { title: t("alertTitle","!"), okLabel: t("ok","OK"), alertOnly: true, danger: false });
  }

  function noteLabel(id) {
    const n = (window.__padApp.getNotes() || []).find(function (x) { return x.id === id; });
    return n ? n.label.split(" ")[0] : id;
  }
  function timbreLabel(id) {
    const t = (window.__padApp.getTimbres() || []).find(function (x) { return x.id === id; });
    return t ? t.label : id;
  }

  function setMode(next) {
    mode = next === "setlist" ? "setlist" : "live";
    document.body.classList.toggle("mode-setlist", mode === "setlist");
    document.body.classList.toggle("mode-live", mode === "live");
    document.querySelectorAll(".mode-tab").forEach(function (btn) {
      btn.setAttribute("aria-selected", btn.dataset.mode === mode ? "true" : "false");
    });
    if (els.panel) {
      if (mode === "setlist") els.panel.removeAttribute("hidden");
      else els.panel.setAttribute("hidden", "");
    }
    var chrome = document.getElementById("setlist-chrome");
    if (chrome) {
      if (mode === "setlist") chrome.removeAttribute("hidden");
      else chrome.setAttribute("hidden", "");
    }
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    if (mode === "setlist") render();
  }

  function renderTabs() {
    if (!els.tabsRow) return;
    els.tabsRow.innerHTML = "";
    store.setlists.forEach(function (sl) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "setlist-tab";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", sl.id === store.activeSetlistId ? "true" : "false");
      btn.dataset.id = sl.id;
      btn.textContent = sl.name;
      btn.title = t("tabHint", "Tap · double-tap rename");

      btn.addEventListener("click", function (e) {
        e.preventDefault();
        const now = Date.now();
        if (lastTap.id === sl.id && now - lastTap.t < 380) {
          lastTap = { id: null, t: 0 };
          if (renameTimer) { clearTimeout(renameTimer); renameTimer = null; }
          startInlineRename(sl.id, btn);
          return;
        }
        lastTap = { id: sl.id, t: now };
        if (renameTimer) clearTimeout(renameTimer);
        renameTimer = setTimeout(function () {
          renameTimer = null;
          if (store.activeSetlistId !== sl.id) {
            store.activeSetlistId = sl.id;
            saveStore();
            render();
          }
        }, 280);
      });

      btn.addEventListener("dblclick", function (e) {
        e.preventDefault();
        if (renameTimer) { clearTimeout(renameTimer); renameTimer = null; }
        lastTap = { id: null, t: 0 };
        startInlineRename(sl.id, btn);
      });

      els.tabsRow.appendChild(btn);
      if (sl.id === store.activeSetlistId) {
        try { btn.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" }); } catch (err) {}
      }
    });
  }

  function startInlineRename(id, chipEl) {
    const sl = store.setlists.find(function (s) { return s.id === id; });
    if (!sl || !chipEl || chipEl.querySelector("input")) return;
    store.activeSetlistId = id;
    saveStore();
    renderTabs();
    const activeChip = els.tabsRow.querySelector('.setlist-tab[data-id="' + id + '"]');
    if (!activeChip) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "setlist-tab-input";
    input.value = sl.name;
    input.maxLength = 32;
    input.setAttribute("aria-label", t("renameList", "Rename"));
    activeChip.textContent = "";
    activeChip.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    function finish(save) {
      if (done) return;
      done = true;
      if (save) {
        const next = String(input.value).trim();
        if (next) sl.name = next.slice(0, 32);
        saveStore();
      }
      render();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", function () { finish(true); });
  }

  function renderList() {
    if (!els.list) return;
    const sl = activeSetlist();
    els.list.innerHTML = "";
    if (!sl.songs.length) {
      const empty = document.createElement("p");
      empty.className = "setlist-hint";
      empty.textContent = t("emptyChords", "—");
      els.list.appendChild(empty);
      return;
    }
    sl.songs.forEach(function (song, idx) {
      const row = document.createElement("div");
      row.className = "song-row" + (song.id === sl.activeSongId ? " is-active" : "");
      row.setAttribute("role", "listitem");
      row.dataset.id = song.id;
      row.draggable = true;

      const ord = document.createElement("div");
      ord.className = "song-ord";
      ord.textContent = String(idx + 1);

      const main = document.createElement("div");
      main.className = "song-row-main";
      const name = document.createElement("div");
      name.className = "song-row-name";
      name.textContent = song.name;
      const meta = document.createElement("div");
      meta.className = "song-row-meta";
      meta.textContent = noteLabel(song.key) + " · " + timbreLabel(song.timbre) + " · " + song.bpm + " · " + song.timeSig + (song.metro ? " · Click" : "");
      main.appendChild(name);
      main.appendChild(meta);

      const tools = document.createElement("div");
      tools.className = "song-row-tools";
      tools.innerHTML =
        '<button type="button" class="icon-btn" data-act="up" title="' + t("moveUp","Up") + '" aria-label="' + t("moveUp","Up") + '">' + ICO.up + '</button>' +
        '<button type="button" class="icon-btn" data-act="down" title="' + t("moveDown","Down") + '" aria-label="' + t("moveDown","Down") + '">' + ICO.down + '</button>' +
        '<button type="button" class="icon-btn" data-act="edit" title="' + t("edit","Edit") + '" aria-label="' + t("edit","Edit") + '">' + ICO.edit + '</button>' +
        '<button type="button" class="icon-btn icon-danger" data-act="del" title="' + t("delete","Delete") + '" aria-label="' + t("delete","Delete") + '">' + ICO.del + '</button>';

      row.appendChild(ord);
      row.appendChild(main);
      row.appendChild(tools);

      row.addEventListener("click", function (e) {
        const btn = e.target.closest("button");
        if (btn) {
          e.stopPropagation();
          const act = btn.dataset.act;
          if (act === "up") moveSong(song.id, -1);
          else if (act === "down") moveSong(song.id, 1);
          else if (act === "edit") openEdit(song.id);
          else if (act === "del") deleteSong(song.id);
          return;
        }
        selectSong(song.id);
      });

      row.addEventListener("dragstart", function (e) {
        dragId = song.id;
        row.classList.add("dragging");
        try { e.dataTransfer.setData("text/plain", song.id); } catch (err) {}
      });
      row.addEventListener("dragend", function () {
        dragId = null;
        row.classList.remove("dragging");
      });
      row.addEventListener("dragover", function (e) {
        e.preventDefault();
      });
      row.addEventListener("drop", function (e) {
        e.preventDefault();
        const from = dragId || (e.dataTransfer && e.dataTransfer.getData("text/plain"));
        if (!from || from === song.id) return;
        reorderTo(from, song.id);
      });

      els.list.appendChild(row);
    });
  }

  function render() {
    renderTabs();
    renderList();
  }

  async function selectSong(id) {
    const sl = activeSetlist();
    const song = sl.songs.find(function (s) { return s.id === id; });
    if (!song) return;

    // Tap again on the currently playing entry → soft-stop and clear highlight
    var padOn = !!(window.__padApp.getActiveId && window.__padApp.getActiveId());
    if (sl.activeSongId === id && padOn) {
      sl.activeSongId = null;
      saveStore();
      renderList();
      if (els.hint) els.hint.textContent = t("stopped", "■");
      window.__padApp.softStopPad();
      return;
    }

    sl.activeSongId = id;
    saveStore();
    renderList();
    if (els.hint) els.hint.textContent = "… " + song.name;
    await window.__padApp.applySong(song);
    if (els.hint) els.hint.textContent = "▶ " + song.name;
  }

  function moveSong(id, dir) {
    const sl = activeSetlist();
    const i = sl.songs.findIndex(function (s) { return s.id === id; });
    const j = i + dir;
    if (i < 0 || j < 0 || j >= sl.songs.length) return;
    const tmp = sl.songs[i];
    sl.songs[i] = sl.songs[j];
    sl.songs[j] = tmp;
    saveStore();
    renderList();
  }

  function reorderTo(fromId, toId) {
    const sl = activeSetlist();
    const from = sl.songs.findIndex(function (s) { return s.id === fromId; });
    const to = sl.songs.findIndex(function (s) { return s.id === toId; });
    if (from < 0 || to < 0 || from === to) return;
    const item = sl.songs.splice(from, 1)[0];
    sl.songs.splice(to, 0, item);
    saveStore();
    renderList();
  }

  async function deleteSong(id) {
    const sl = activeSetlist();
    const song = sl.songs.find(function (s) { return s.id === id; });
    if (!song) return;
    const ok = await appConfirm(t("confirmDeleteChord","Delete") + " " + song.name + "?", {
      title: t("deleteChord","Delete"),
      okLabel: t("delete","Delete"),
      danger: true,
    });
    if (!ok) return;
    sl.songs = sl.songs.filter(function (s) { return s.id !== id; });
    if (sl.activeSongId === id) sl.activeSongId = null;
    saveStore();
    render();
  }

  function fillEditSelects() {
    const keySel = document.getElementById("song-edit-key");
    keySel.innerHTML = "";
    window.__padApp.getNotes().forEach(function (n) {
      const o = document.createElement("option");
      o.value = n.id; o.textContent = n.label;
      keySel.appendChild(o);
    });
  }

  function syncSongTimbreUI(timbre) {
    const hidden = document.getElementById("song-edit-timbre");
    if (hidden) hidden.value = timbre;
    const wrap = document.getElementById("song-edit-timbres");
    if (!wrap) return;
    wrap.querySelectorAll(".timbre-pick").forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-timbre") === timbre ? "true" : "false");
    });
  }

  function applySongTimbreEQ(timbre) {
    const map = (window.__padApp && window.__padApp.getTimbreEQ && window.__padApp.getTimbreEQ()) || {};
    const eq = map[timbre] || map.pad || { hipass: 70, lopass: 9000 };
    const hi = document.getElementById("song-edit-hipass");
    const lo = document.getElementById("song-edit-lopass");
    if (hi) hi.value = String(eq.hipass);
    if (lo) lo.value = String(eq.lopass);
    syncSongSlider("hipass");
    syncSongSlider("lopass");
  }

  function formatSongSlider(param, v) {
    v = Number(v);
    if (param === "bpm") return String(Math.round(v));
    if (param === "hipass" || param === "lopass") {
      return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + " kHz" : Math.round(v) + " Hz";
    }
    if (param === "reverb" || param === "volume") return Math.round(v * 100) + "%";
    return String(v);
  }


  function syncSongSigUI(sig) {
    const wrap = document.getElementById("song-edit-sigs");
    const hidden = document.getElementById("song-edit-sig");
    if (hidden) hidden.value = sig;
    if (!wrap) return;
    wrap.querySelectorAll(".sig-pick").forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-sig") === sig ? "true" : "false");
    });
  }

  function syncSongMetroUI(on) {
    const btn = document.getElementById("song-edit-metro");
    if (!btn) return;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function syncSongSlider(param) {
    const input = document.getElementById("song-edit-" + param);
    const valEl = document.getElementById("song-val-" + param);
    if (!input || !valEl) return;
    valEl.textContent = formatSongSlider(param, input.value);
  }

  function syncAllSongSliders() {
    ["bpm", "hipass", "lopass", "reverb", "volume"].forEach(syncSongSlider);
  }

  function beginPreviewSession() {
    if (previewSession) return;
    previewSession = { snapshot: window.__padApp.capturePadState() };
  }

  async function endPreviewSession(keep) {
    if (!previewSession) return;
    const snap = previewSession.snapshot;
    previewSession = null;
    if (!keep) {
      await window.__padApp.restorePadState(snap);
    }
  }

  async function previewFromModal() {
    if (!previewSession || els.modal.hidden) return;
    const draft = readModalSong();
    // Always apply settings + start pad so edits are audible while modal is open
    await window.__padApp.applySong(draft);
  }

  function openEdit(id) {
    fillEditSelects();
    const sl = activeSetlist();
    let song = id ? sl.songs.find(function (s) { return s.id === id; }) : null;
    editSongId = song ? song.id : null;
    if (!song) {
      const snap = window.__padApp.snapshotSongFields();
      song = normalizeSong(Object.assign({ name: t("newChord","Chord 1") }, snap));
    }
    const settings = window.__padApp.getSettings();
    document.getElementById("song-edit-name").value = song.name;
    document.getElementById("song-edit-key").value = song.key;
    syncSongTimbreUI(song.timbre);
    document.getElementById("song-edit-bpm").value = String(song.bpm);
    syncSongSigUI(song.timeSig);
    syncSongMetroUI(!!song.metro);
    document.getElementById("song-edit-hipass").value = String(song.hipass != null ? song.hipass : settings.hipass);
    document.getElementById("song-edit-lopass").value = String(song.lopass != null ? song.lopass : settings.lopass);
    document.getElementById("song-edit-reverb").value = String(song.reverb != null ? song.reverb : settings.reverb);
    document.getElementById("song-edit-volume").value = String(song.volume != null ? song.volume : settings.volume);
    syncAllSongSliders();
    beginPreviewSession();
    els.modal.hidden = false;
    document.body.classList.add("editing-chord");
    previewFromModal();
  }

  function readModalSong() {
    const raw = {
      id: editSongId || uid(),
      name: document.getElementById("song-edit-name").value.trim() || "Chord",
      key: document.getElementById("song-edit-key").value,
      timbre: document.getElementById("song-edit-timbre").value,
      bpm: Number(document.getElementById("song-edit-bpm").value),
      timeSig: document.getElementById("song-edit-sig").value,
      metro: document.getElementById("song-edit-metro").getAttribute("aria-pressed") === "true",
    };
    raw.hipass = Number(document.getElementById("song-edit-hipass").value);
    raw.lopass = Number(document.getElementById("song-edit-lopass").value);
    raw.reverb = Number(document.getElementById("song-edit-reverb").value);
    raw.volume = Number(document.getElementById("song-edit-volume").value);
    return normalizeSong(raw);
  }

  async function saveModal() {
    const song = readModalSong();
    const sl = activeSetlist();
    const idx = sl.songs.findIndex(function (s) { return s.id === song.id; });
    if (idx >= 0) sl.songs[idx] = song;
    else sl.songs.push(song);
    sl.activeSongId = song.id;
    saveStore();
    els.modal.hidden = true;
    document.body.classList.remove("editing-chord");
    await endPreviewSession(true);
    // Keep current preview as the playing state
    await window.__padApp.applySong(song);
    if (els.hint) els.hint.textContent = "▶ " + song.name;
    render();
  }

  async function cancelModal() {
    els.modal.hidden = true;
    document.body.classList.remove("editing-chord");
    await endPreviewSession(false);
  }

  function addSong() { openEdit(null); }

  function newSetlist() {
    const sl = {
      id: uid(),
      name: t("setlistPrefix","List") + " " + (store.setlists.length + 1),
      songs: [],
      activeSongId: null,
    };
    store.setlists.push(sl);
    store.activeSetlistId = sl.id;
    saveStore();
    render();
    // Immediately offer inline rename on the new chip
    const chip = els.tabsRow && els.tabsRow.querySelector('.setlist-tab[data-id="' + sl.id + '"]');
    if (chip) startInlineRename(sl.id, chip);
  }

  async function deleteSetlist() {
    if (store.setlists.length <= 1) {
      await appAlert(t("keepOneSetlist","Keep at least one list"));
      return;
    }
    const sl = activeSetlist();
    const ok = await appConfirm(
      t("confirmDeleteSetlist","Delete") + " " + sl.name + "?",
      { title: t("deleteSetlist","Delete list"), okLabel: t("delete","Delete"), danger: true }
    );
    if (!ok) return;
    store.setlists = store.setlists.filter(function (s) { return s.id !== sl.id; });
    store.activeSetlistId = store.setlists[0].id;
    saveStore();
    render();
  }

  function nextSong(dir) {
    const sl = activeSetlist();
    if (!sl.songs.length) return;
    let i = sl.songs.findIndex(function (s) { return s.id === sl.activeSongId; });
    if (i < 0) i = 0;
    else i = (i + dir + sl.songs.length) % sl.songs.length;
    selectSong(sl.songs[i].id);
  }

  // Wire UI
  if (els.tabs) {
    els.tabs.addEventListener("click", function (e) {
      const btn = e.target.closest(".mode-tab");
      if (btn) setMode(btn.dataset.mode);
    });
  }
  document.getElementById("setlist-new").addEventListener("click", newSetlist);
  document.getElementById("setlist-delete").addEventListener("click", deleteSetlist);
  document.getElementById("song-add").addEventListener("click", addSong);
  document.getElementById("song-prev").addEventListener("click", function () { nextSong(-1); });
  document.getElementById("song-next").addEventListener("click", function () { nextSong(1); });
  document.getElementById("song-modal-cancel").addEventListener("click", function () { cancelModal(); });
  document.getElementById("song-modal-ok").addEventListener("click", function () { saveModal(); });

  ["bpm", "hipass", "lopass", "reverb", "volume"].forEach(function (param) {
    const input = document.getElementById("song-edit-" + param);
    if (!input) return;
    input.addEventListener("input", function () {
      syncSongSlider(param);
      previewFromModal();
    });
  });
  (function () {
    const keyEl = document.getElementById("song-edit-key");
    if (keyEl) keyEl.addEventListener("change", function () { previewFromModal(); });
    const wrap = document.getElementById("song-edit-timbres");
    if (wrap) {
      wrap.addEventListener("click", function (e) {
        const btn = e.target.closest(".timbre-pick");
        if (!btn) return;
        const timbre = btn.getAttribute("data-timbre");
        syncSongTimbreUI(timbre);
        applySongTimbreEQ(timbre);
        previewFromModal();
      });
    }
  })();
  (function () {
    const wrap = document.getElementById("song-edit-sigs");
    if (wrap) {
      wrap.addEventListener("click", function (e) {
        const btn = e.target.closest(".sig-pick");
        if (!btn) return;
        syncSongSigUI(btn.getAttribute("data-sig"));
        previewFromModal();
      });
    }
    const metroBtn = document.getElementById("song-edit-metro");
    if (metroBtn) {
      metroBtn.addEventListener("click", function () {
        const on = metroBtn.getAttribute("aria-pressed") !== "true";
        syncSongMetroUI(on);
        previewFromModal();
      });
    }
  })();

  // Expose for verify
  window.__setlist = {
    getStore: function () { return JSON.parse(JSON.stringify(store)); },
    setMode: setMode,
    getMode: function () { return mode; },
    addSongData: function (data) {
      const sl = activeSetlist();
      const song = normalizeSong(Object.assign({ id: uid() }, data));
      sl.songs.push(song);
      sl.activeSongId = song.id;
      saveStore();
      render();
      return song.id;
    },
    selectSong: selectSong,
    nextSong: nextSong,
    render: render,
    appConfirm: appConfirm,
    deleteSong: deleteSong,
    deleteSetlist: deleteSetlist,
  };

  // Init
  setMode(mode);
})();
