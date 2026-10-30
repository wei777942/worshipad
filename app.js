(function () {
  "use strict";

  // UI strings (easy to translate). Visual chrome is icon-first / language-neutral.
  const I18N = {
    tapToStart: "Tap a key",
    muted: "Mute",
    stopped: "Stop",
    metroStart: "Start beat",
    metroStop: "Stop beat",
    foh: "FOH split",
    mute: "MUTE",
    live: "Live",
    setlist: "List",
    confirmTitle: "Delete?",
    confirmOk: "Yes",
    cancel: "No",
    ok: "OK",
    alertTitle: "Note",
    delete: "Delete",
    deleteChord: "Delete?",
    deleteSetlist: "Delete list?",
    confirmDeleteChord: "Delete",
    confirmDeleteSetlist: "Delete",
    keepOneSetlist: "Keep one list",
    emptyChords: "—",
    edit: "Edit",
    moveUp: "Up",
    moveDown: "Down",
    editChord: "Edit",
    addChord: "Add",
    newChord: "Chord 1",
    setlistPrefix: "List",
    name: "Name",
    playing: "Play",
    loading: "…",
    useEq: "EQ",
    useFx: "FX",
    ready: "Ready",
    tabHint: "Tap · double-tap rename",
    renameList: "Rename",
  };
  window.__padI18n = I18N;



  const NOTES = [
    { id: "C", label: "C", midi: 48 },
    { id: "Cs", label: "C♯ / D♭", midi: 49 },
    { id: "D", label: "D", midi: 50 },
    { id: "Ds", label: "D♯ / E♭", midi: 51 },
    { id: "E", label: "E", midi: 52 },
    { id: "F", label: "F", midi: 53 },
    { id: "Fs", label: "F♯ / G♭", midi: 54 },
    { id: "G", label: "G", midi: 55 },
    { id: "Gs", label: "G♯ / A♭", midi: 56 },
    { id: "A", label: "A", midi: 57 },
    { id: "As", label: "A♯ / B♭", midi: 58 },
    { id: "B", label: "B", midi: 59 },
  ];

  const TIMBRES = [
    "pad", "analog", "sky",
    "warm", "cello", "violins", "tremolo", "swell", "glass",
    "felt", "crystal", "rhodes",
    "acoustic", "electric", "bass",
  ];

  const TIMBRE_LABELS = {
    pad: "Crystal", analog: "Warm", sky: "Sky",
    warm: "Group", cello: "Cello", violins: "Violin",
    tremolo: "Shake", swell: "Rise", glass: "Glass",
    felt: "Soft", crystal: "Bell", rhodes: "Keys",
    acoustic: "Guitar", electric: "Rock", bass: "Bass",
  };

  // Recommended Low Cut / High Cut per timbre (keeps main content)
  const TIMBRE_EQ = {
    pad:      { hipass: 70,  lopass: 9000 },
    analog:   { hipass: 55,  lopass: 4200 },
    sky:      { hipass: 120, lopass: 14000 },
    warm:     { hipass: 90,  lopass: 6000 },
    cello:    { hipass: 45,  lopass: 2800 },
    violins:  { hipass: 200, lopass: 15000 },
    tremolo:  { hipass: 110, lopass: 7500 },
    swell:    { hipass: 80,  lopass: 5500 },
    glass:    { hipass: 140, lopass: 11000 },
    felt:     { hipass: 40,  lopass: 3200 },
    crystal:  { hipass: 220, lopass: 16000 },
    rhodes:   { hipass: 90,  lopass: 5500 },
    acoustic: { hipass: 80,  lopass: 9000 },
    electric: { hipass: 100, lopass: 5500 },
    bass:     { hipass: 35,  lopass: 1600 },
  };

  const DEFAULTS = {
    crossfade: 3,
    hipass: 70,
    lopass: 9000,
    reverb: 0.55,
    pan: 0,
    volume: 0.5,
    timbre: "pad",
    bpm: 100,
    timeSig: "4/4",
    metroVol: 0.6,
    metroPan: 0,
    fohSplit: false,
  };

  const STORAGE_KEY = "pad-live-settings-v9";
  const RAMP = 0.08;
  const MUTE_RAMP = 0.04;
  const MIN_FADE = 0.02;
  const MAX_FB = 0.92; // never allow delay feedback >= 1
  const OUT_CEILING = 0.707; // ~-3 dBFS hard clamp

  const keysEl = document.getElementById("keys");
  const statusEl = null;
  function setStatus(text) { /* status line removed */ }
  const muteBtn = document.getElementById("mute-btn");
  const metroToggleBtn = document.getElementById("metro-toggle");
  const beatDotsEl = document.getElementById("beat-dots");
  const tapTempoBtn = document.getElementById("tap-tempo");
  const fohSplitEl = document.getElementById("foh-split");

  const settings = Object.assign({}, DEFAULTS, loadSettings());
  if (TIMBRES.indexOf(settings.timbre) < 0) settings.timbre = "pad";
  settings.bpm = Math.max(40, Math.min(220, settings.bpm || 100));
  if (["2/4", "3/4", "4/4", "6/8"].indexOf(settings.timeSig) < 0) settings.timeSig = "4/4";
  settings.metroVol = Math.max(0, Math.min(1, settings.metroVol == null ? 0.6 : settings.metroVol));
  settings.metroPan = Math.max(-1, Math.min(1, settings.metroPan || 0));
  settings.fohSplit = !!settings.fohSplit;

  let started = false;

  let audioRebuildLock = false;

  function waitMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function resumeToneContext() {
    try {
      if (Tone.context.state !== "running") {
        await Tone.start();
      }
    } catch (e) {}
    try {
      if (Tone.context.state !== "running" && Tone.context.resume) {
        await Tone.context.resume();
      }
    } catch (e2) {}
    try {
      const raw = Tone.context.rawContext;
      if (raw && raw.state !== "running" && raw.resume) await raw.resume();
    } catch (e3) {}
    return Tone.context.state === "running";
  }

  async function disposeAudioGraphSoft() {
    try { disposeFadingNow(); } catch (e) {}
    try {
      Array.from(voices.keys()).forEach(function (id) {
        const v = voices.get(id);
        voices.delete(id);
        try { if (v) v.dispose(); } catch (e2) {}
      });
    } catch (e3) {}
    try { if (metroRunning) stopMetronome(true); } catch (e4) {}
    [chorus, delay, reverb, master, limiter, safetyCompressor].forEach(function (n) {
      try { if (n && n.dispose) n.dispose(); } catch (e5) {}
    });
    try { if (breathLfo) { breathLfo.stop(); } } catch (e6) {}
    [hipass, lopass, breathLfo, breathDepth, panner, muteGain, metroGain, metroPanner, safetyBrick, outputAnalyser, leftAnalyser, rightAnalyser].forEach(function (n) {
      try { if (n && n.disconnect) n.disconnect(); } catch (e7) {}
    });
    hipass = lopass = breathLfo = breathDepth = null;
    chorus = delay = reverb = panner = master = muteGain = limiter = null;
    safetyCompressor = safetyBrick = outputAnalyser = leftAnalyser = rightAnalyser = null;
    metroGain = metroPanner = null;
    started = false;
  }

  async function rebuildAudioGraph() {
    if (audioRebuildLock) return false;
    audioRebuildLock = true;
    const keepId = activeId;
    const wasMetro = metroRunning;
    try {
      await disposeAudioGraphSoft();
      try { await Tone.context.close(); } catch (e) {}
      try {
        const next = new Tone.Context({ latencyHint: "interactive" });
        Tone.setContext(next);
      } catch (e2) {
        try { Tone.setContext(new Tone.Context({ latencyHint: "interactive" })); } catch (e3) {}
      }
      await ensureAudio();
      if (keepId) {
        activeId = null;
        activeMidi = null;
        await playKeyForce(keepId);
      }
      if (wasMetro) {
        try { startMetronome(); } catch (e4) {}
      }
      return Tone.context.state === "running";
    } catch (err) {
      try { console.warn("WORSHIPAD audio rebuild", err); } catch (e5) {}
      return false;
    } finally {
      audioRebuildLock = false;
    }
  }

  async function ensureContextHealthy() {
    if (!started) {
      await ensureAudio();
      return;
    }
    if (Tone.context.state === "running") return;
    const ok = await resumeToneContext();
    if (ok) return;
    await waitMs(300);
    if (Tone.context.state === "running") return;
    await resumeToneContext();
    if (Tone.context.state === "running") return;
    await rebuildAudioGraph();
  }

  let activeId = null;
  let activeMidi = null;
  const voices = new Map();
  const fadingVoices = [];
  let retargetToken = 0;

  let hipass = null;
  let lopass = null;
  let breathLfo = null;
  let breathDepth = null;
  let chorus = null;
  let delay = null;
  let reverb = null;
  let panner = null;
  let master = null;
  let muteGain = null;
  let limiter = null;
  let safetyCompressor = null;
  let safetyBrick = null;
  let outputAnalyser = null;
  let _meterBuf = null;
  let leftAnalyser = null;
  let rightAnalyser = null;

  // Metronome
  let metroGain = null;
  let metroPanner = null;
  let metroRunning = false;
  let metroBeat = 0;
  let metroSchedId = null;
  let tapTimes = [];
  const beatLog = []; // performance.now() stamps for verify

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const out = {};
      Object.keys(DEFAULTS).forEach(function (k) {
        const t = typeof DEFAULTS[k];
        if (t === "number" && typeof parsed[k] === "number" && !isNaN(parsed[k])) out[k] = parsed[k];
        if (t === "string" && typeof parsed[k] === "string") out[k] = parsed[k];
        if (t === "boolean" && typeof parsed[k] === "boolean") out[k] = parsed[k];
      });
      return out;
    } catch (e) { return {}; }
  }

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function ctxNow() { return Tone.context.rawContext.currentTime; }

  function formatVal(param, v) {
    if (param === "crossfade") return v.toFixed(1) + "s";
    if (param === "hipass" || param === "lopass") {
      return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + " kHz" : Math.round(v) + " Hz";
    }
    if (param === "reverb" || param === "volume" || param === "metroVol") return Math.round(v * 100) + "%";
    if (param === "bpm") return String(Math.round(v));
    if (param === "pan" || param === "metroPan") {
      if (Math.abs(v) < 0.02) return "C";
      return (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100);
    }
    return String(v);
  }

  function rampParam(audioParam, value, timeConstant) {
    if (!audioParam) return;
    const now = ctxNow();
    audioParam.cancelScheduledValues(now);
    audioParam.setValueAtTime(audioParam.value, now);
    audioParam.setTargetAtTime(value, now, timeConstant || RAMP);
  }

  function fadeGain(gainNode, to, duration) {
    if (!gainNode) return;
    const g = gainNode.gain;
    const now = ctxNow();
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(to, now + Math.max(MIN_FADE, duration));
  }

  function applyLive(param, value) {
    settings[param] = value;
    if (!started) return;
    if (param === "hipass") rampParam(hipass.frequency, value);
    else if (param === "lopass") {
      rampParam(lopass.frequency, value, 0.12);
    } else if (param === "reverb" && reverb) {
      const wet = reverb.wet;
      const now = Tone.now();
      wet.cancelScheduledValues(now);
      wet.setValueAtTime(wet.value, now);
      wet.linearRampToValueAtTime(value, now + RAMP * 3);
    } else if (param === "pan") applyPanRouting();
    else if (param === "metroPan") applyPanRouting();
    else if (param === "metroVol" && metroGain) {
      rampParam(metroGain.gain, Math.max(0, Math.min(1, value)) * 0.9, 0.05);
    } else if (param === "bpm") {
      const bpm = Math.max(40, Math.min(220, value));
      settings.bpm = bpm;
      if (started) Tone.Transport.bpm.rampTo(bpm, 0.05);
    } else if (param === "volume" && master) {
      const now = Tone.now();
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(Math.min(1, value) * 0.85, now + RAMP * 3);
    }
  }

  function beatsPerBar(sig) {
    if (sig === "2/4") return 2;
    if (sig === "3/4") return 3;
    if (sig === "6/8") return 6;
    return 4;
  }

  function metroSubdivision(sig) {
    return sig === "6/8" ? "8n" : "4n";
  }

  function applyPanRouting() {
    if (!panner) return;
    if (settings.fohSplit) {
      rampParam(panner.pan, 1, 0.04); // pad hard right
      if (metroPanner) rampParam(metroPanner.pan, -1, 0.04); // click hard left
    } else {
      rampParam(panner.pan, settings.pan, 0.04);
      if (metroPanner) rampParam(metroPanner.pan, settings.metroPan, 0.04);
    }
  }

  function rebuildBeatDots() {
    if (!beatDotsEl) return;
    const n = beatsPerBar(settings.timeSig);
    beatDotsEl.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const d = document.createElement("span");
      d.className = "beat-dot";
      d.dataset.beat = String(i);
      beatDotsEl.appendChild(d);
    }
  }

  function flashBeat(beatIdx) {
    if (!beatDotsEl) return;
    const dots = beatDotsEl.querySelectorAll(".beat-dot");
    dots.forEach(function (d, i) {
      d.classList.toggle("is-on", i === beatIdx);
      d.classList.toggle("is-accent", i === beatIdx && beatIdx === 0);
    });
  }

  /** Soft woodblock / click — short decaying sine; accent = higher + louder */
  function playMetroClick(time, accent) {
    if (!metroGain) return;
    const ctx = Tone.context.rawContext;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(accent ? 1680 : 1120, time);
    const g = ctx.createGain();
    const peak = (accent ? 0.7 : 0.38) * 1;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, time + (accent ? 0.055 : 0.035));
    // tiny noise tick for woodblock body
    const nLen = Math.max(1, Math.floor(ctx.sampleRate * 0.012));
    const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
    const data = nBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / nLen);
    const noise = ctx.createBufferSource();
    noise.buffer = nBuf;
    const nBp = ctx.createBiquadFilter();
    nBp.type = "bandpass";
    nBp.frequency.setValueAtTime(accent ? 2400 : 1800, time);
    nBp.Q.value = 2.5;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(accent ? 0.22 : 0.12, time);
    nG.gain.exponentialRampToValueAtTime(0.0001, time + 0.02);
    osc.connect(g); g.connect(metroGain);
    noise.connect(nBp); nBp.connect(nG); nG.connect(metroGain);
    osc.start(time); osc.stop(time + 0.08);
    noise.start(time);
  }

  function stopMetronome(fromMute) {
    metroRunning = false;
    updateMediaSession();
    if (metroSchedId != null) {
      try { Tone.Transport.clear(metroSchedId); } catch (e) {}
      metroSchedId = null;
    }
    try {
      Tone.Transport.stop();
      Tone.Transport.cancel(0);
    } catch (e2) {}
    metroBeat = 0;
    if (metroToggleBtn) {
      metroToggleBtn.setAttribute("aria-pressed", "false");
      metroToggleBtn.setAttribute("aria-label", I18N.metroStart);
    }
    if (beatDotsEl) {
      beatDotsEl.querySelectorAll(".beat-dot").forEach(function (d) {
        d.classList.remove("is-on", "is-accent");
      });
    }
    // soft duck — no abrupt click on stop (envelopes already short)
    if (metroGain) {
      try {
        const now = ctxNow();
        metroGain.gain.cancelScheduledValues(now);
        metroGain.gain.setValueAtTime(metroGain.gain.value, now);
        metroGain.gain.linearRampToValueAtTime(0.0001, now + 0.03);
      } catch (e3) {}
    }
  }

  function startMetronome() {
    if (!started) return;
    stopMetronome(false);
    // restore volume after soft duck from prior stop
    const vol = Math.max(0, Math.min(1, settings.metroVol)) * 0.9;
    const now = ctxNow();
    metroGain.gain.cancelScheduledValues(now);
    metroGain.gain.setValueAtTime(vol, now);
    applyPanRouting();
    Tone.Transport.bpm.value = settings.bpm;
    metroBeat = 0;
    const subdiv = metroSubdivision(settings.timeSig);
    const bpb = beatsPerBar(settings.timeSig);
    metroSchedId = Tone.Transport.scheduleRepeat(function (time) {
      const idx = metroBeat % bpb;
      const accent = idx === 0;
      playMetroClick(time, accent);
      beatLog.push(performance.now());
      if (beatLog.length > 128) beatLog.shift();
      Tone.Draw.schedule(function () { flashBeat(idx); }, time);
      metroBeat += 1;
    }, subdiv);
    Tone.Transport.start("+0.05");
    metroRunning = true;
    updateMediaSession();
    notifyNativeKeepAlive(true);
    if (metroToggleBtn) {
      metroToggleBtn.setAttribute("aria-pressed", "true");
      metroToggleBtn.setAttribute("aria-label", I18N.metroStop);
    }
  }

  async function toggleMetronome() {
    await ensureAudio();
    try {
      const now = ctxNow();
      if (muteGain && muteGain.gain.value < 0.99) {
        muteGain.gain.cancelScheduledValues(now);
        muteGain.gain.setValueAtTime(1, now);
      }
    } catch (e) {}
    muteBtn.setAttribute("aria-pressed", "false");
    muteBtn.classList.remove("is-flash");
    if (metroRunning) stopMetronome(false);
    else startMetronome();
  }

  function handleTapTempo() {
    const t = performance.now();
    tapTimes.push(t);
    tapTimes = tapTimes.filter(function (x) { return t - x < 3000; });
    if (tapTimes.length < 2) return;
    const intervals = [];
    for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
    const avg = intervals.reduce(function (a, b) { return a + b; }, 0) / intervals.length;
    let bpm = Math.round(60000 / avg);
    bpm = Math.max(40, Math.min(220, bpm));
    applyLive("bpm", bpm);
    syncUI("bpm");
    saveSettings();
  }

  function addOsc(nodes, ctx, now, type, freq, detune, amp, dest) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, now);
    if (detune != null) o.detune.setValueAtTime(detune, now);
    const g = ctx.createGain();
    g.gain.value = amp;
    o.connect(g); g.connect(dest); o.start(now);
    nodes.push(o);
    return o;
  }

  function addVib(nodes, ctx, now, osc, depth, rate) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate + Math.random() * 0.3;
    const g = ctx.createGain();
    g.gain.value = depth;
    lfo.connect(g); g.connect(osc.detune); lfo.start(now);
    nodes.push(lfo);
  }

  /**
   * One infinitely sustained drone: root + fifth + octave,
   * voiced in the selected instrument character. This IS the pad.
   */
  function TimbreVoice(rootMidi, timbre) {
    const ctx = Tone.context.rawContext;
    const now = ctx.currentTime;
    this.nodes = [];
    this.timers = [];
    this.timbre = timbre;
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(0, now);

    const intervals = [0, 7, 12];
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.45;
    this.nodes.push(filter);
    const bus = ctx.createGain();
    bus.gain.value = 1;
    this.nodes.push(bus);

    const self = this;

    if (timbre === "pad") {
      // 水晶: shimmering airy worship pad — high sparkle FM + soft body
      filter.frequency.value = 3800;
      filter.Q.value = 0.35;
      const amps = [0.16, 0.12, 0.1];
      intervals.forEach(function (semi, i) {
        addOsc(self.nodes, ctx, now, "sine", midiToFreq(rootMidi + semi), -3, amps[i], filter);
        addOsc(self.nodes, ctx, now, "triangle", midiToFreq(rootMidi + semi), 5, amps[i] * 0.35, filter);
      });
      // airy high shimmer (held FM bells an octave up)
      [12, 19, 24].forEach(function (semi, i) {
        const base = midiToFreq(rootMidi + semi);
        const car = ctx.createOscillator(); car.type = "sine";
        car.frequency.setValueAtTime(base, now);
        const mod = ctx.createOscillator(); mod.type = "sine";
        mod.frequency.setValueAtTime(base * 2.005, now);
        const mG = ctx.createGain(); mG.gain.value = 55 + i * 15;
        mod.connect(mG); mG.connect(car.frequency);
        const cG = ctx.createGain();
        cG.gain.setValueAtTime(0, now);
        cG.gain.linearRampToValueAtTime(0.045 - i * 0.008, now + 2.5);
        car.connect(cG); cG.connect(filter);
        car.start(now); mod.start(now);
        self.nodes.push(car, mod, mG, cG);
      });
      // slow airy filter breath
      const air = ctx.createOscillator(); air.type = "sine"; air.frequency.value = 0.08;
      const airG = ctx.createGain(); airG.gain.value = 900;
      air.connect(airG); airG.connect(filter.frequency); air.start(now);
      self.nodes.push(air, airG);
    } else if (timbre === "analog") {
      // 暖底: warm analog pad — soft saws, gentle LP, slow breath
      filter.type = "lowpass";
      filter.frequency.value = 1400;
      filter.Q.value = 0.45;
      const soft = ctx.createGain();
      soft.gain.setValueAtTime(0, now);
      soft.gain.linearRampToValueAtTime(1, now + 1.6);
      intervals.forEach(function (semi) {
        [-10, -4, 0, 5, 11].forEach(function (cents) {
          const o = addOsc(self.nodes, ctx, now, "sawtooth", midiToFreq(rootMidi + semi), cents, 0.028, soft);
          addVib(self.nodes, ctx, now, o, 2.2, 2.8);
        });
        addOsc(self.nodes, ctx, now, "triangle", midiToFreq(rootMidi + semi), 0, 0.045, soft);
        addOsc(self.nodes, ctx, now, "sine", midiToFreq(rootMidi + semi - 12), 0, 0.04, soft);
      });
      soft.connect(filter);
      const breath = ctx.createOscillator(); breath.type = "sine"; breath.frequency.value = 0.07;
      const breathG = ctx.createGain(); breathG.gain.value = 550;
      breath.connect(breathG); breathG.connect(filter.frequency); breath.start(now);
      self.nodes.push(soft, breath, breathG);
    } else if (timbre === "sky") {
      // 天空: airy choir / vowel pad + high-octave shimmer
      filter.frequency.value = 3200;
      filter.Q.value = 0.35;
      const soft = ctx.createGain();
      soft.gain.setValueAtTime(0, now);
      soft.gain.linearRampToValueAtTime(1, now + 1.8);
      // choir-ish body (sine+triangle stack, slight formant feel via detune)
      intervals.forEach(function (semi, i) {
        const amps = [0.12, 0.09, 0.075];
        const f = midiToFreq(rootMidi + semi);
        addOsc(self.nodes, ctx, now, "sine", f, -4, amps[i], soft);
        addOsc(self.nodes, ctx, now, "triangle", f, 3, amps[i] * 0.55, soft);
        addOsc(self.nodes, ctx, now, "sine", f * 2, 6, amps[i] * 0.22, soft); // vowel-ish 2nd
        const o = addOsc(self.nodes, ctx, now, "sine", f, 0, amps[i] * 0.35, soft);
        addVib(self.nodes, ctx, now, o, 4.5, 4.0);
      });
      soft.connect(filter);
      // high octave airy shimmer (held)
      [12, 19, 24, 31].forEach(function (semi, i) {
        const base = midiToFreq(rootMidi + semi);
        const car = ctx.createOscillator(); car.type = "sine";
        car.frequency.setValueAtTime(base, now);
        const mod = ctx.createOscillator(); mod.type = "sine";
        mod.frequency.setValueAtTime(base * 1.997, now);
        const mG = ctx.createGain(); mG.gain.value = 35 + i * 12;
        mod.connect(mG); mG.connect(car.frequency);
        const cG = ctx.createGain();
        cG.gain.setValueAtTime(0, now);
        cG.gain.linearRampToValueAtTime(0.038 - i * 0.006, now + 2.8);
        car.connect(cG); cG.connect(filter);
        car.start(now); mod.start(now);
        self.nodes.push(car, mod, mG, cG);
      });
      const air = ctx.createOscillator(); air.type = "sine"; air.frequency.value = 0.06;
      const airG = ctx.createGain(); airG.gain.value = 700;
      air.connect(airG); airG.connect(filter.frequency); air.start(now);
      self.nodes.push(soft, air, airG);
    } else if (timbre === "warm") {
      // 合奏: thick warm string ensemble — many detuned saws, gentle vib
      filter.frequency.value = 1900;
      filter.Q.value = 0.4;
      intervals.forEach(function (semi) {
        [-14, -9, -4, 0, 5, 10, 15].forEach(function (cents) {
          const o = addOsc(self.nodes, ctx, now, "sawtooth", midiToFreq(rootMidi + semi), cents, 0.026, filter);
          addVib(self.nodes, ctx, now, o, 4, 3.6);
        });
        addOsc(self.nodes, ctx, now, "triangle", midiToFreq(rootMidi + semi), 0, 0.04, filter);
      });
    } else if (timbre === "cello") {
      // 大琴: dark bowed cello section — low register, slow attack, slow vib
      filter.frequency.value = 700;
      filter.Q.value = 0.55;
      const bow = ctx.createGain();
      bow.gain.setValueAtTime(0, now);
      bow.gain.linearRampToValueAtTime(1, now + 1.1); // slow bow-on
      [-12, -5, 0].forEach(function (semi) {
        [-6, -2, 0, 3, 7].forEach(function (cents) {
          const o = addOsc(self.nodes, ctx, now, "sawtooth", midiToFreq(rootMidi + semi), cents, 0.048, bow);
          addVib(self.nodes, ctx, now, o, 2.8, 2.6);
        });
        addOsc(self.nodes, ctx, now, "triangle", midiToFreq(rootMidi + semi), 0, 0.07, bow);
      });
      bow.connect(filter);
      self.nodes.push(bow);
    } else if (timbre === "violins") {
      // 高弦: bright high violins — upper register, heavy vibrato
      filter.frequency.value = 5200;
      filter.Q.value = 0.4;
      [12, 19, 24, 31].forEach(function (semi) {
        [-11, -5, 0, 6, 12].forEach(function (cents) {
          const o = addOsc(self.nodes, ctx, now, "sawtooth", midiToFreq(rootMidi + semi), cents, 0.028, filter);
          addVib(self.nodes, ctx, now, o, 9, 6.2); // heavy vib
        });
      });
      addOsc(self.nodes, ctx, now, "triangle", midiToFreq(rootMidi + 24), 0, 0.045, filter);
      addOsc(self.nodes, ctx, now, "sine", midiToFreq(rootMidi + 36), 0, 0.028, filter);
    } else if (timbre === "tremolo") {
      // 顫音: clear deep amp tremolo on string pad
      filter.frequency.value = 2600;
      intervals.forEach(function (semi) {
        [-8, -3, 0, 4, 9].forEach(function (cents) {
          const o = addOsc(self.nodes, ctx, now, "sawtooth", midiToFreq(rootMidi + semi), cents, 0.04, filter);
          addVib(self.nodes, ctx, now, o, 3.5, 4.2);
        });
      });
      bus.gain.value = 0.78;
      const trem = ctx.createOscillator();
      trem.type = "sine"; trem.frequency.value = 6.0;
      const tremG = ctx.createGain(); tremG.gain.value = 0.48; // deep, obvious
      trem.connect(tremG); tremG.connect(bus.gain); trem.start(now);
      self.nodes.push(trem, tremG);
    } else if (timbre === "swell") {
      // 漸強: obvious slow amp+filter swell into held pad (cycles gently)
      filter.frequency.value = 900;
      intervals.forEach(function (semi) {
        [-10, -4, 0, 5, 11].forEach(function (cents) {
          const o = addOsc(self.nodes, ctx, now, "sawtooth", midiToFreq(rootMidi + semi), cents, 0.048, filter);
          addVib(self.nodes, ctx, now, o, 3.5, 3.5);
        });
      });
      // long swell in, then slow breathing that stays audible
      bus.gain.setValueAtTime(0.05, now);
      bus.gain.linearRampToValueAtTime(1, now + 4.5);
      const lfoF = ctx.createOscillator();
      lfoF.type = "sine"; lfoF.frequency.value = 1 / 10;
      const lfoFG = ctx.createGain(); lfoFG.gain.value = 1100;
      filter.frequency.value = 1200;
      lfoF.connect(lfoFG); lfoFG.connect(filter.frequency); lfoF.start(now);
      const lfoA = ctx.createOscillator();
      lfoA.type = "sine"; lfoA.frequency.value = 1 / 10;
      const lfoAG = ctx.createGain(); lfoAG.gain.value = 0.18;
      // after swell settles, breathe around ~0.85
      const breatheAt = now + 5;
      bus.gain.setValueAtTime(1, breatheAt);
      lfoA.connect(lfoAG); lfoAG.connect(bus.gain); lfoA.start(breatheAt);
      self.nodes.push(lfoF, lfoA, lfoFG, lfoAG);
    } else if (timbre === "glass") {
      // 合成: 80s string machine — pulse/square + wide chorus detune
      filter.frequency.value = 4200;
      filter.Q.value = 0.5;
      [0, 7, 12, 19].forEach(function (semi) {
        [-18, -9, 0, 9, 18].forEach(function (cents) {
          const o = addOsc(self.nodes, ctx, now, "square", midiToFreq(rootMidi + semi), cents, 0.016, filter);
          addVib(self.nodes, ctx, now, o, 5, 5.5);
        });
        [-12, 0, 12].forEach(function (cents) {
          addOsc(self.nodes, ctx, now, "sawtooth", midiToFreq(rootMidi + semi), cents, 0.014, filter);
        });
      });
      // chorus-ish slow detune LFO on filter for machine width
      const chor = ctx.createOscillator(); chor.type = "sine"; chor.frequency.value = 0.55;
      const chorG = ctx.createGain(); chorG.gain.value = 350;
      chor.connect(chorG); chorG.connect(filter.frequency); chor.start(now);
      self.nodes.push(chor, chorG);
    } else if (timbre === "felt") {
      // 毛氈: muffled felt piano — dark, soft attack, few highs
      filter.frequency.value = 950;
      filter.Q.value = 0.6;
      const soft = ctx.createGain();
      soft.gain.setValueAtTime(0, now);
      soft.gain.linearRampToValueAtTime(1, now + 0.45);
      intervals.forEach(function (semi, i) {
        const amps = [0.22, 0.14, 0.1];
        const f = midiToFreq(rootMidi + semi);
        addOsc(self.nodes, ctx, now, "triangle", f, -2, amps[i], soft);
        addOsc(self.nodes, ctx, now, "sine", f * 2, 1, amps[i] * 0.22, soft);
        addOsc(self.nodes, ctx, now, "sine", f * 3, -1, amps[i] * 0.06, soft);
      });
      soft.connect(filter);
      self.nodes.push(soft);
    } else if (timbre === "crystal") {
      // 鐘琴: bright bell-like FM — inharmonic, glassy attack into sustain
      filter.frequency.value = 6500;
      filter.Q.value = 0.35;
      intervals.forEach(function (semi, i) {
        const base = midiToFreq(rootMidi + semi + 12);
        const car = ctx.createOscillator(); car.type = "sine";
        car.frequency.setValueAtTime(base, now);
        const mod = ctx.createOscillator(); mod.type = "sine";
        mod.frequency.setValueAtTime(base * 3.01, now); // more bell-like ratio
        const mG = ctx.createGain();
        mG.gain.setValueAtTime(140 + i * 30, now);
        mG.gain.exponentialRampToValueAtTime(40 + i * 10, now + 2.5); // index settles
        mod.connect(mG); mG.connect(car.frequency);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(0.11 - i * 0.02, now + 0.04);
        car.connect(g); g.connect(filter);
        car.start(now); mod.start(now);
        self.nodes.push(car, mod, mG, g);
      });
      intervals.forEach(function (semi) {
        addOsc(self.nodes, ctx, now, "sine", midiToFreq(rootMidi + semi), 0, 0.07, filter);
      });
    } else if (timbre === "rhodes") {
      // 電琴: Rhodes tine + body, clear electric tremolo
      filter.frequency.value = 2600;
      const soft = ctx.createGain();
      soft.gain.setValueAtTime(0, now);
      soft.gain.linearRampToValueAtTime(1, now + 0.12);
      intervals.forEach(function (semi, i) {
        const f = midiToFreq(rootMidi + semi);
        const amps = [0.17, 0.12, 0.1];
        addOsc(self.nodes, ctx, now, "sine", f, 0, amps[i], soft);
        addOsc(self.nodes, ctx, now, "sine", f * 2, 6, amps[i] * 0.38, soft); // bright tine
        addOsc(self.nodes, ctx, now, "sine", f * 4, -4, amps[i] * 0.08, soft);
        addOsc(self.nodes, ctx, now, "triangle", f, -2, amps[i] * 0.18, soft);
      });
      soft.connect(filter);
      bus.gain.value = 0.72;
      const trem = ctx.createOscillator();
      trem.type = "sine"; trem.frequency.value = 5.2;
      const tremG = ctx.createGain(); tremG.gain.value = 0.26; // obvious Rhodes trem
      trem.connect(tremG); tremG.connect(bus.gain); trem.start(now);
      self.nodes.push(soft, trem, tremG);
    } else if (timbre === "acoustic") {
      // 木吉: bright acoustic — rich partials + one-shot pluck (no feedback)
      filter.frequency.value = 4200;
      filter.Q.value = 0.45;
      const body = ctx.createGain();
      body.gain.setValueAtTime(0, now);
      body.gain.linearRampToValueAtTime(0.9, now + 0.28);
      intervals.forEach(function (semi, i) {
        const amps = [0.13, 0.09, 0.075];
        const f = midiToFreq(rootMidi + semi);
        addOsc(self.nodes, ctx, now, "triangle", f, -4, amps[i], body);
        addOsc(self.nodes, ctx, now, "sine", f * 2, 5, amps[i] * 0.4, body);
        addOsc(self.nodes, ctx, now, "sine", f * 3, -3, amps[i] * 0.18, body);
        addOsc(self.nodes, ctx, now, "sine", f * 4, 2, amps[i] * 0.08, body);
        addOsc(self.nodes, ctx, now, "triangle", f, 8, amps[i] * 0.12, body);
      });
      body.connect(filter);
      self.nodes.push(body);
      intervals.forEach(function (semi, i) {
        const f = midiToFreq(rootMidi + semi);
        const noise = ctx.createBufferSource();
        const nLen = Math.max(1, Math.floor(ctx.sampleRate * 0.035));
        const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
        const data = nBuf.getChannelData(0);
        for (let n = 0; n < data.length; n++) data[n] = (Math.random() * 2 - 1) * (1 - n / nLen);
        noise.buffer = nBuf;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass"; bp.frequency.value = Math.min(f * 2.2, 5000); bp.Q.value = 3.5;
        const nG = ctx.createGain();
        nG.gain.setValueAtTime(0.2 - i * 0.04, now);
        nG.gain.exponentialRampToValueAtTime(0.0008, now + 0.7);
        noise.connect(bp); bp.connect(nG); nG.connect(filter);
        noise.start(now);
        self.nodes.push(noise, bp, nG);
      });
    } else if (timbre === "electric") {
      // 電吉: pedal overdrive / warm crunch — pre-EQ → drive → cab-sim → normalize → swell
      // Deliberate effect tone, not a broken limiter blast.
      filter.frequency.value = 4500;
      filter.Q.value = 0.4;

      const preH = ctx.createBiquadFilter();
      preH.type = "highpass"; preH.frequency.value = 90; preH.Q.value = 0.7;
      const preL = ctx.createBiquadFilter();
      preL.type = "lowpass"; preL.frequency.value = 3200; preL.Q.value = 0.8; // push mids into drive
      const preMid = ctx.createBiquadFilter();
      preMid.type = "peaking"; preMid.frequency.value = 800; preMid.Q.value = 0.9; preMid.gain.value = 4;

      const drive = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      const amount = 4.2; // crunchy but soft-clipped
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        // asymmetric tube-ish soft clip (pedal character)
        const y = (1 + amount) * x / (1 + amount * Math.abs(x));
        const asym = y + 0.08 * y * y;
        curve[i] = Math.max(-0.95, Math.min(0.95, asym * 0.72));
      }
      drive.curve = curve;
      drive.oversample = "4x";

      const cab = ctx.createBiquadFilter();
      cab.type = "lowpass"; cab.frequency.value = 4500; cab.Q.value = 0.55; // cab-sim
      const cabH = ctx.createBiquadFilter();
      cabH.type = "highpass"; cabH.frequency.value = 70; cabH.Q.value = 0.5;

      const postNorm = ctx.createGain();
      postNorm.gain.value = 0.85; // normalize after drive to match other timbres

      const swell = ctx.createGain();
      swell.gain.setValueAtTime(0.001, now);
      swell.gain.exponentialRampToValueAtTime(1, now + 1.4); // volume-pedal swell

      intervals.forEach(function (semi, i) {
        const amps = [0.14, 0.1, 0.08];
        const f = midiToFreq(rootMidi + semi);
        [-7, -2, 0, 3, 8].forEach(function (cents) {
          const o = addOsc(self.nodes, ctx, now, "sawtooth", f, cents, amps[i] * 0.22, preH);
          addVib(self.nodes, ctx, now, o, 3, 3.8);
        });
        addOsc(self.nodes, ctx, now, "triangle", f, 0, amps[i] * 0.3, preH);
        addOsc(self.nodes, ctx, now, "square", f, 4, amps[i] * 0.06, preH);
      });

      preH.connect(preMid); preMid.connect(preL); preL.connect(drive);
      drive.connect(cabH); cabH.connect(cab); cab.connect(postNorm);
      postNorm.connect(swell); swell.connect(filter);

      // gentle post-cab chorus wobble on filter
      const chor = ctx.createOscillator(); chor.type = "sine"; chor.frequency.value = 0.4;
      const chorG = ctx.createGain(); chorG.gain.value = 200;
      chor.connect(chorG); chorG.connect(filter.frequency); chor.start(now);

      self.nodes.push(preH, preMid, preL, drive, cab, cabH, postNorm, swell, chor, chorG);
    } else if (timbre === "bass") {
      // 貝斯: warm synth/sub bass — sine sub + filtered saw growl, phone-audible 150–800Hz, mud-clean
      const lowRoot = rootMidi - 24;
      filter.type = "lowpass";
      filter.frequency.value = 720;
      filter.Q.value = 0.55;

      // dry sine sub (deep, clean) — bypass the growly filter
      const subBus = ctx.createGain();
      subBus.gain.setValueAtTime(0, now);
      subBus.gain.linearRampToValueAtTime(1, now + 0.4);
      const f0 = midiToFreq(lowRoot);
      addOsc(self.nodes, ctx, now, "sine", f0, 0, 0.22, subBus);
      // careful octave; skip f*0.5 to avoid inaudible rumble mud
      addOsc(self.nodes, ctx, now, "sine", midiToFreq(lowRoot + 12), 0, 0.06, subBus);
      subBus.connect(bus);

      // growly filtered saw body (harmonics land ~150–800Hz for phones)
      const growlLP = ctx.createBiquadFilter();
      growlLP.type = "lowpass";
      growlLP.frequency.value = 380;
      growlLP.Q.value = 1.8; // mild resonance = growl
      const growlHP = ctx.createBiquadFilter();
      growlHP.type = "highpass";
      growlHP.frequency.value = 90; // keep mud out of the saw layer
      growlHP.Q.value = 0.5;
      const growlGain = ctx.createGain();
      growlGain.gain.setValueAtTime(0, now);
      growlGain.gain.linearRampToValueAtTime(0.85, now + 0.55);

      // soft asymmetric drive for a touch of growl (not blast)
      const growlShaper = ctx.createWaveShaper();
      const curve = new Float32Array(512);
      for (let i = 0; i < 512; i++) {
        const x = (i / 511) * 2 - 1;
        const y = Math.tanh(x * 1.8) * 0.85 + 0.05 * x * x;
        curve[i] = Math.max(-0.9, Math.min(0.9, y));
      }
      growlShaper.curve = curve;
      growlShaper.oversample = "2x";

      [0, 7].forEach(function (semi, i) {
        const f = midiToFreq(lowRoot + semi);
        const amp = i === 0 ? 0.11 : 0.055;
        [-5, 0, 6].forEach(function (cents) {
          addOsc(self.nodes, ctx, now, "sawtooth", f, cents, amp, growlHP);
        });
        addOsc(self.nodes, ctx, now, "triangle", f, 0, amp * 0.45, growlHP);
        // explicit mid partials for phone speakers (~150–800Hz)
        addOsc(self.nodes, ctx, now, "sine", f * 2, 0, amp * 0.35, growlHP);
        addOsc(self.nodes, ctx, now, "sine", f * 3, 0, amp * 0.18, growlHP);
        addOsc(self.nodes, ctx, now, "sine", f * 4, 0, amp * 0.08, growlHP);
      });

      growlHP.connect(growlLP);
      growlLP.connect(growlShaper);
      growlShaper.connect(growlGain);
      growlGain.connect(filter);

      // slow filter movement (synth bass character)
      const lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 0.12;
      const lfoG = ctx.createGain(); lfoG.gain.value = 220;
      lfo.connect(lfoG); lfoG.connect(growlLP.frequency); lfo.start(now);

      bus.gain.setValueAtTime(0, now);
      bus.gain.linearRampToValueAtTime(1, now + 0.35);
      self.nodes.push(subBus, growlHP, growlLP, growlShaper, growlGain, lfo, lfoG);
    } else {
      filter.frequency.value = 2000;
      intervals.forEach(function (semi) {
        addOsc(self.nodes, ctx, now, "sine", midiToFreq(rootMidi + semi), 0, 0.18, filter);
      });
    }

    filter.connect(bus);
    bus.connect(this.gain);
    this.gain.connect(hipass);
  }

  TimbreVoice.prototype.fadeIn = function (d) { fadeGain(this.gain, 1, d); };
  TimbreVoice.prototype.fadeOut = function (d) {
    fadeGain(this.gain, 0, d);
    const self = this;
    setTimeout(function () { self.dispose(); }, Math.max(MIN_FADE, d) * 1000 + 80);
  };
  TimbreVoice.prototype.dispose = function () {
    this.timers.forEach(function (id) { clearInterval(id); });
    this.timers = [];
    try {
      this.nodes.forEach(function (n) {
        try {
          if (n.gain && n.gain.value != null) {
            try { n.gain.cancelScheduledValues(0); n.gain.value = 0; } catch (e2) {}
          }
          if (n.stop) n.stop();
          n.disconnect();
        } catch (e) {}
      });
      try { this.gain.gain.value = 0; } catch (e3) {}
      this.gain.disconnect();
    } catch (e) {}
    this.nodes = [];
    const idx = fadingVoices.indexOf(this);
    if (idx >= 0) fadingVoices.splice(idx, 1);
  };

  function disposeFadingNow() {
    while (fadingVoices.length) {
      const v = fadingVoices.pop();
      try { v.dispose(); } catch (e) {}
    }
  }

  function stopVoice(id, duration) {
    const v = voices.get(id);
    if (!v) return;
    voices.delete(id);
    fadingVoices.push(v);
    v.fadeOut(duration);
  }
  function stopAllVoices(duration) {
    Array.from(voices.keys()).forEach(function (id) { stopVoice(id, duration); });
  }

  function startVoice(id, midi, duration) {
    if (!id || midi == null) return;
    if (voices.has(id)) return;
    const v = new TimbreVoice(midi, settings.timbre);
    voices.set(id, v);
    v.fadeIn(duration);
  }

  /** Switch timbre while holding a key: crossfade old → new. Kill prior fades to avoid stack. */
  function retargetTimbre(duration) {
    const dur = fadeSecs(duration);
    if (!activeId || activeMidi == null) return;
    const id = activeId;
    const midi = activeMidi;
    const token = ++retargetToken;
    disposeFadingNow(); // prevent gain stacking from rapid switches
    stopVoice(id, Math.min(dur, 1.2));
    setTimeout(function () {
      if (token !== retargetToken) return;
      if (activeId === id && activeMidi === midi) {
        startVoice(id, midi, dur);
      }
    }, 40);
  }

  async function ensureAudio() {
    if (started) return;
    await Tone.start();
    const ctx = Tone.context.rawContext;

    hipass = ctx.createBiquadFilter();
    hipass.type = "highpass";
    hipass.frequency.value = settings.hipass;
    hipass.Q.value = 0.5;

    lopass = ctx.createBiquadFilter();
    lopass.type = "lowpass";
    lopass.frequency.value = settings.lopass;
    lopass.Q.value = 0.45;

    breathLfo = ctx.createOscillator();
    breathLfo.type = "sine";
    breathLfo.frequency.value = 1 / 12;
    breathDepth = ctx.createGain();
    breathDepth.gain.value = 280;
    breathLfo.connect(breathDepth);
    breathDepth.connect(lopass.frequency);
    breathLfo.start();

    panner = ctx.createStereoPanner();
    panner.pan.value = settings.pan;

    metroGain = ctx.createGain();
    metroGain.gain.value = Math.max(0, Math.min(1, settings.metroVol)) * 0.9;
    metroPanner = ctx.createStereoPanner();
    metroPanner.pan.value = settings.fohSplit ? -1 : settings.metroPan;

    chorus = new Tone.Chorus({ frequency: 0.32, delayTime: 4.8, depth: 0.5, wet: 0.35 }).start();
    const delayFb = Math.min(0.26, MAX_FB);
    delay = new Tone.FeedbackDelay({ delayTime: 0.42, feedback: delayFb, wet: 0.14 });
    reverb = new Tone.Reverb({ decay: 9, preDelay: 0.08, wet: settings.reverb });
    await reverb.generate();

    // Headroom on master; brickwall + limiter enforce ~-3 dBFS ceiling
    master = new Tone.Gain(Math.min(1, settings.volume) * 0.85);
    muteGain = ctx.createGain();
    muteGain.gain.value = 1;

    const compressor = new Tone.Compressor({
      threshold: -18,
      ratio: 6,
      attack: 0.003,
      release: 0.12,
      knee: 6,
    });
    safetyCompressor = compressor;

    const brick = ctx.createWaveShaper();
    const brickCurve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      const y = Math.tanh(x * 1.4);
      brickCurve[i] = Math.max(-OUT_CEILING, Math.min(OUT_CEILING, y * OUT_CEILING));
    }
    brick.curve = brickCurve;
    brick.oversample = "2x";
    safetyBrick = brick;

    limiter = new Tone.Limiter(-3);

    outputAnalyser = ctx.createAnalyser();
    outputAnalyser.fftSize = 2048;
    outputAnalyser.smoothingTimeConstant = 0.15;

    hipass.connect(lopass);
    const bridge = Tone.context.createGain();
    bridge.gain.value = 0.9;
    lopass.connect(bridge);
    Tone.connect(bridge, chorus);
    chorus.connect(delay);
    delay.connect(reverb);
    const post = Tone.context.createGain();
    post.gain.value = 0.9;
    Tone.connect(reverb, post);
    post.connect(panner);
    panner.connect(muteGain);

    // Metronome joins at muteGain so MUTE ducks/stops everything
    metroGain.connect(metroPanner);
    metroPanner.connect(muteGain);
    applyPanRouting();

    // muteGain (raw) → master (Tone) → compressor → brick → limiter → destination
    // + parallel tap to analyser + L/R split for FOH verify
    const tap = ctx.createGain();
    tap.gain.value = 1;
    muteGain.connect(tap);
    Tone.connect(tap, master);

    const split = ctx.createChannelSplitter(2);
    const splitGain = ctx.createGain();
    splitGain.gain.value = 1;
    muteGain.connect(splitGain);
    splitGain.connect(split);
    leftAnalyser = ctx.createAnalyser();
    rightAnalyser = ctx.createAnalyser();
    leftAnalyser.fftSize = 2048;
    rightAnalyser.fftSize = 2048;
    leftAnalyser.smoothingTimeConstant = 0.1;
    rightAnalyser.smoothingTimeConstant = 0.1;
    split.connect(leftAnalyser, 0);
    split.connect(rightAnalyser, 1);
    master.connect(compressor);
    const brickIn = ctx.createGain();
    brickIn.gain.value = 1;
    Tone.connect(compressor, brickIn);
    brickIn.connect(brick);
    const brickOut = ctx.createGain();
    brickOut.gain.value = 1;
    brick.connect(brickOut);
    Tone.connect(brickOut, limiter);
    limiter.connect(outputAnalyser); // meter tap only (AnalyserNode is not in the audible chain)
    limiter.toDestination(); // single audible path — no MediaStream bridge, no doubling
    try {
      // Larger lookAhead = smoother scheduling under background CPU pressure (no context recreate).
      if (Tone.context && typeof Tone.context.lookAhead === "number") {
        Tone.context.lookAhead = Math.max(Tone.context.lookAhead || 0, 0.12);
      }
    } catch (eLA) {}
    updateMediaSession();
    notifyNativeKeepAlive(true);

    started = true;
    applyPanRouting();
    setStatus(I18N.ready);
  }

  function setActiveUI(id) {
    document.querySelectorAll(".key").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.id === id);
    });
    updateMediaSession();
    notifyNativeKeepAlive(!!id || metroRunning);
  }

  function fadeSecs(override) {
    if (typeof override === "number") return Math.max(MIN_FADE, override);
    return Math.max(MIN_FADE, settings.crossfade || 0);
  }

  function hardStop() {
    if (!started) {
      activeId = null;
      activeMidi = null;
      setActiveUI(null);
      setStatus(I18N.stopped);
      stopMetronome(true);
      return;
    }
    stopMetronome(true);
    fadeGain(muteGain, 0, MUTE_RAMP);
    muteBtn.classList.add("is-flash");
    muteBtn.setAttribute("aria-pressed", "true");
    stopAllVoices(MUTE_RAMP);
    setTimeout(disposeFadingNow, MUTE_RAMP * 1000 + 100);
    activeId = null;
    activeMidi = null;
    setActiveUI(null);
    setStatus(I18N.stopped);
    setTimeout(function () {
      try {
        const now = ctxNow();
        muteGain.gain.cancelScheduledValues(now);
        muteGain.gain.setValueAtTime(1, now);
      } catch (e) {}
      muteBtn.classList.remove("is-flash");
      muteBtn.setAttribute("aria-pressed", "false");
    }, MUTE_RAMP * 1000 + 60);
  }

  async function onKey(id, midi, label) {
    await ensureContextHealthy();
    try {
      const now = ctxNow();
      if (muteGain.gain.value < 0.99) {
        muteGain.gain.cancelScheduledValues(now);
        muteGain.gain.setValueAtTime(1, now);
      }
    } catch (e) {}
    muteBtn.setAttribute("aria-pressed", "false");
    muteBtn.classList.remove("is-flash");

    const dur = fadeSecs();

    if (activeId === id) {
      stopVoice(id, dur);
      activeId = null;
      activeMidi = null;
      setActiveUI(null);
      setStatus(I18N.muted);
      return;
    }

    if (activeId) stopVoice(activeId, dur);

    activeId = id;
    activeMidi = midi;
    startVoice(id, midi, dur);
    setActiveUI(id);
    setStatus(I18N.playing + " · " + label);
  }

  NOTES.forEach(function (n) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "key";
    btn.dataset.id = n.id;
    btn.textContent = n.label;
    btn.setAttribute("aria-label", "Pad " + n.label);
    btn.addEventListener("pointerdown", function () { btn.classList.add("is-pressed"); });
    btn.addEventListener("pointerup", function (e) {
      e.preventDefault();
      btn.classList.remove("is-pressed");
      onKey(n.id, n.midi, n.label);
    });
    btn.addEventListener("pointercancel", function () { btn.classList.remove("is-pressed"); });
    btn.addEventListener("pointerleave", function () { btn.classList.remove("is-pressed"); });
    keysEl.appendChild(btn);
  });

  muteBtn.addEventListener("click", async function () {
    await ensureContextHealthy();
    hardStop();
  });

  const PARAMS = ["crossfade", "hipass", "lopass", "reverb", "pan", "volume", "bpm", "metroVol", "metroPan"];

  function syncUI(param) {
    const input = document.getElementById("ctrl-" + param);
    const valEl = document.getElementById("val-" + param);
    if (!input || !valEl) return;
    input.value = String(settings[param]);
    valEl.textContent = formatVal(param, settings[param]);
  }

  function recommendedEQ(timbre) {
    return TIMBRE_EQ[timbre] || TIMBRE_EQ.pad;
  }

  function applyTimbreEQ(type) {
    const eq = recommendedEQ(type);
    settings.hipass = eq.hipass;
    settings.lopass = eq.lopass;
    syncUI("hipass");
    syncUI("lopass");
    if (started) {
      rampParam(hipass.frequency, eq.hipass, 0.25);
      rampParam(lopass.frequency, eq.lopass, 0.25);
    }
  }

  function resetParam(param) {
    let v = DEFAULTS[param];
    if (param === "hipass" || param === "lopass") {
      v = recommendedEQ(settings.timbre)[param];
    }
    applyLive(param, v);
    syncUI(param);
    saveSettings();
  }

  PARAMS.forEach(function (param) {
    const input = document.getElementById("ctrl-" + param);
    syncUI(param);
    input.addEventListener("input", function () {
      const v = parseFloat(input.value);
      applyLive(param, v);
      document.getElementById("val-" + param).textContent = formatVal(param, v);
      saveSettings();
    });
    input.addEventListener("dblclick", function (e) { e.preventDefault(); resetParam(param); });
    let lastTap = 0;
    input.addEventListener("pointerup", function () {
      const now = Date.now();
      if (now - lastTap < 320) { resetParam(param); lastTap = 0; }
      else lastTap = now;
    });
  });

  /* --- Hardware rotary knobs: enhance input[type=range], keep range as source of truth --- */
  function enhanceRangeKnob(input) {
    if (!input || input.dataset.knobEnhanced === "1") return;
    input.dataset.knobEnhanced = "1";
    const wrap = document.createElement("div");
    wrap.className = "hw-knob";
    wrap.style.setProperty("--knob-glow", "#a78bfa");
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add("hw-knob-input");
    input.setAttribute("tabindex", "-1");

    const face = document.createElement("div");
    face.className = "hw-knob-face";
    face.setAttribute("aria-hidden", "true");
    const ring = document.createElement("div");
    ring.className = "hw-knob-ring";
    const cap = document.createElement("div");
    cap.className = "hw-knob-cap";
    const ind = document.createElement("div");
    ind.className = "hw-knob-indicator";
    cap.appendChild(ind);
    face.appendChild(ring);
    face.appendChild(cap);
    wrap.insertBefore(face, input);

    function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }

    function paint() {
      const min = parseFloat(input.min);
      const max = parseFloat(input.max);
      const v = parseFloat(input.value);
      const pct = max === min ? 0 : clamp((v - min) / (max - min), 0, 1);
      const angle = -135 + pct * 270;
      wrap.style.setProperty("--knob-pct", String(pct * 100));
      wrap.style.setProperty("--knob-angle", angle + "deg");
      wrap.style.setProperty("--knob-fill", pct * 270 + "deg");
    }

    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (proto && proto.set && proto.get) {
      Object.defineProperty(input, "value", {
        configurable: true,
        enumerable: true,
        get: function () { return proto.get.call(this); },
        set: function (v) { proto.set.call(this, v); paint(); },
      });
    }
    input.addEventListener("input", paint);
    paint();

    input.addEventListener("dblclick", function () {
      if (!input.id || input.id.indexOf("song-edit-") !== 0) return;
      input.value = input.defaultValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    let lastTap = 0;
    let drag = null;

    function applyFromDelta(dy) {
      const min = parseFloat(input.min);
      const max = parseFloat(input.max);
      const step = parseFloat(input.step);
      const stepN = isFinite(step) && step > 0 ? step : 1;
      const range = max - min;
      const sens = 130;
      let next = drag.startVal + (dy / sens) * range;
      const decimals = (String(stepN).split(".")[1] || "").length;
      next = Math.round(next / stepN) * stepN;
      next = clamp(next, min, max);
      if (decimals) next = parseFloat(next.toFixed(decimals));
      if (String(next) !== input.value) {
        input.value = String(next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    function finishDrag(moved) {
      wrap.classList.remove("is-dragging");
      drag = null;
      if (!moved) {
        const now = Date.now();
        if (now - lastTap < 320) {
          lastTap = 0;
          input.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        } else {
          lastTap = now;
        }
      } else {
        lastTap = 0;
      }
    }

    face.addEventListener("pointerdown", function (e) {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      wrap.classList.add("is-dragging");
      drag = { pointerId: e.pointerId, startY: e.clientY, startVal: parseFloat(input.value), moved: false };
      try { face.setPointerCapture(e.pointerId); } catch (err) {}
    });

    face.addEventListener("pointermove", function (e) {
      if (!drag) return;
      if (drag.pointerId != null && e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      const dy = drag.startY - e.clientY;
      if (Math.abs(dy) > 3) drag.moved = true;
      applyFromDelta(dy);
    });

    face.addEventListener("pointerup", function (e) {
      if (!drag) return;
      if (drag.pointerId != null && e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      const moved = drag.moved;
      try { if (face.hasPointerCapture && face.hasPointerCapture(e.pointerId)) face.releasePointerCapture(e.pointerId); } catch (err) {}
      finishDrag(moved);
    });

    face.addEventListener("pointercancel", function (e) {
      if (!drag) return;
      finishDrag(true);
    });
  }

  function enhanceAllKnobs(root) {
    (root || document).querySelectorAll(".control input[type=range]").forEach(enhanceRangeKnob);
  }
  enhanceAllKnobs(document);

  function syncTimbreUI() {
    document.querySelectorAll("#timbre-panel .timbre-pick").forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.dataset.timbre === settings.timbre ? "true" : "false");
    });
  }

  async function setTimbre(type) {
    if (TIMBRES.indexOf(type) < 0) return;
    if (settings.timbre === type) return;
    settings.timbre = type;
    syncTimbreUI();
    applyTimbreEQ(type);
    saveSettings();
    if (!started) return;
    if (activeId) retargetTimbre(settings.crossfade);
  }

  syncTimbreUI();
  document.querySelectorAll("#timbre-panel .timbre-pick").forEach(function (btn) {
    btn.addEventListener("pointerdown", function () { btn.classList.add("is-pressed"); });
    btn.addEventListener("pointerup", function () { btn.classList.remove("is-pressed"); });
    btn.addEventListener("pointercancel", function () { btn.classList.remove("is-pressed"); });
    btn.addEventListener("pointerleave", function () { btn.classList.remove("is-pressed"); });
    btn.addEventListener("click", async function () {
      await ensureAudio();
      setTimbre(btn.dataset.timbre);
    });
  });

  function syncSigUI() {
    document.querySelectorAll(".metro-sigs .sig-pick").forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.dataset.sig === settings.timeSig ? "true" : "false");
    });
  }

  rebuildBeatDots();
  syncSigUI();
  function syncFohUI() {
    if (!fohSplitEl) return;
    fohSplitEl.setAttribute("aria-pressed", settings.fohSplit ? "true" : "false");
  }
  syncFohUI();
  syncUI("bpm");
  syncUI("metroVol");
  syncUI("metroPan");

  if (metroToggleBtn) {
    metroToggleBtn.addEventListener("click", function () { toggleMetronome(); });
  }
  if (tapTempoBtn) {
    tapTempoBtn.addEventListener("click", function () { handleTapTempo(); });
  }
  document.querySelectorAll(".metro-sigs .sig-pick").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      settings.timeSig = btn.dataset.sig;
      syncSigUI();
      rebuildBeatDots();
      saveSettings();
      if (metroRunning) {
        await ensureAudio();
        startMetronome(); // restart with new sig
      }
    });
  });
  if (fohSplitEl) {
    fohSplitEl.addEventListener("click", function () {
      settings.fohSplit = !settings.fohSplit;
      syncFohUI();
      applyPanRouting();
      saveSettings();
    });
  }

  function readOutputLevels() {
    if (!outputAnalyser) return { peak: 0, rms: 0, peakDb: -Infinity, rmsDb: -Infinity };
    if (!_meterBuf || _meterBuf.length !== outputAnalyser.fftSize) {
      _meterBuf = new Float32Array(outputAnalyser.fftSize);
    }
    outputAnalyser.getFloatTimeDomainData(_meterBuf);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < _meterBuf.length; i++) {
      const v = _meterBuf[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / _meterBuf.length);
    return {
      peak: peak,
      rms: rms,
      peakDb: 20 * Math.log10(peak || 1e-9),
      rmsDb: 20 * Math.log10(rms || 1e-9),
      voices: voices.size,
      fading: fadingVoices.length,
    };
  }

  function readChannelLevels() {
    function measure(an) {
      if (!an) return { peak: 0, rms: 0 };
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let peak = 0, sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sum += v * v;
      }
      return { peak: peak, rms: Math.sqrt(sum / buf.length) };
    }
    return { left: measure(leftAnalyser), right: measure(rightAnalyser) };
  }


  function noteById(id) {
    for (let i = 0; i < NOTES.length; i++) if (NOTES[i].id === id) return NOTES[i];
    return NOTES[0];
  }

  function setTimeSig(sig) {
    if (["2/4", "3/4", "4/4", "6/8"].indexOf(sig) < 0) sig = "4/4";
    settings.timeSig = sig;
    syncSigUI();
    rebuildBeatDots();
    saveSettings();
    if (metroRunning) startMetronome();
  }

  /** Force-start a pad key with crossfade (does not toggle off if same key). */
  async function playKeyForce(id) {
    await ensureContextHealthy();
    try {
      const now = ctxNow();
      if (muteGain && muteGain.gain.value < 0.99) {
        muteGain.gain.cancelScheduledValues(now);
        muteGain.gain.setValueAtTime(1, now);
      }
    } catch (e) {}
    muteBtn.setAttribute("aria-pressed", "false");
    muteBtn.classList.remove("is-flash");

    const note = noteById(id);
    const dur = fadeSecs();
    if (activeId === note.id) {
      // same key: rebuild voice for new timbre/settings
      retargetTimbre(dur);
      setStatus(I18N.playing + " · " + note.label);
      return;
    }
    if (activeId) stopVoice(activeId, dur);
    activeId = note.id;
    activeMidi = note.midi;
    startVoice(note.id, note.midi, dur);
    setActiveUI(note.id);
    setStatus(I18N.playing + " · " + note.label);
  }

  /**
   * Apply a setlist song patch then start its key.
   * Optional: hipass/lopass/reverb/volume when present on song.
   */
  async function applySong(song) {
    if (!song) return;
    await ensureAudio();
    const timbre = TIMBRES.indexOf(song.timbre) >= 0 ? song.timbre : "pad";
    const key = noteById(song.key).id;
    const bpm = Math.max(40, Math.min(220, Number(song.bpm) || 100));
    const sig = song.timeSig || "4/4";

    settings.timbre = timbre;
    syncTimbreUI();

    const hasEq = song.hipass != null && song.lopass != null;
    if (hasEq) {
      applyLive("hipass", Number(song.hipass));
      applyLive("lopass", Number(song.lopass));
      syncUI("hipass");
      syncUI("lopass");
    } else {
      applyTimbreEQ(timbre);
    }

    if (song.reverb != null) {
      applyLive("reverb", Math.max(0, Math.min(1, Number(song.reverb))));
      syncUI("reverb");
    }
    if (song.volume != null) {
      applyLive("volume", Math.max(0, Math.min(1, Number(song.volume))));
      syncUI("volume");
    }

    applyLive("bpm", bpm);
    syncUI("bpm");
    setTimeSig(sig);
    saveSettings();

    if (song.metro) {
      if (!metroRunning) startMetronome();
    } else {
      if (metroRunning) stopMetronome(false);
    }

    await playKeyForce(key);
  }

  function softStopPad() {
    const dur = fadeSecs();
    if (activeId) stopVoice(activeId, dur);
    activeId = null;
    activeMidi = null;
    setActiveUI(null);
    if (statusEl) setStatus(I18N.muted);
  }

  function capturePadState() {
    return {
      settings: {
        timbre: settings.timbre,
        bpm: settings.bpm,
        timeSig: settings.timeSig,
        hipass: settings.hipass,
        lopass: settings.lopass,
        reverb: settings.reverb,
        volume: settings.volume,
        crossfade: settings.crossfade,
        pan: settings.pan,
      },
      activeId: activeId,
      metroRunning: metroRunning,
    };
  }

  async function restorePadState(state) {
    if (!state || !state.settings) return;
    await ensureAudio();
    const s = state.settings;
    settings.timbre = TIMBRES.indexOf(s.timbre) >= 0 ? s.timbre : settings.timbre;
    syncTimbreUI();
    if (s.hipass != null) { applyLive("hipass", Number(s.hipass)); syncUI("hipass"); }
    if (s.lopass != null) { applyLive("lopass", Number(s.lopass)); syncUI("lopass"); }
    if (s.reverb != null) { applyLive("reverb", Number(s.reverb)); syncUI("reverb"); }
    if (s.volume != null) { applyLive("volume", Number(s.volume)); syncUI("volume"); }
    if (s.bpm != null) { applyLive("bpm", Number(s.bpm)); syncUI("bpm"); }
    if (s.timeSig) setTimeSig(s.timeSig);
    saveSettings();
    if (state.activeId) await playKeyForce(state.activeId);
    else softStopPad();
    if (state.metroRunning) {
      if (!metroRunning) startMetronome();
    } else {
      if (metroRunning) stopMetronome(false);
    }
  }

  function snapshotSongFields() {
    return {
      key: activeId || "C",
      timbre: settings.timbre,
      bpm: settings.bpm,
      timeSig: settings.timeSig,
      metro: false,
      hipass: settings.hipass,
      lopass: settings.lopass,
      reverb: settings.reverb,
      volume: settings.volume,
    };
  }



  function notifyNativeKeepAlive(playing) {
    try {
      const Cap = window.Capacitor;
      if (Cap && Cap.Plugins && Cap.Plugins.WorshipKeepAlive && typeof Cap.Plugins.WorshipKeepAlive.setPlaying === "function") {
        Cap.Plugins.WorshipKeepAlive.setPlaying({ playing: !!playing });
      }
    } catch (e) {}
  }

  function updateMediaSession() {
    try {
      if (!("mediaSession" in navigator)) return;
      const playing = !!(activeId || metroRunning);
      const label = activeId ? (NOTES.find(function (n) { return n.id === activeId; }) || {}).label || activeId : "WORSHIPAD";
      navigator.mediaSession.metadata = new MediaMetadata({
        title: playing ? String(label).split(" ")[0] : "WORSHIPAD",
        artist: "WORSHIPAD",
        album: "Pad",
      });
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
      try {
        navigator.mediaSession.setActionHandler("pause", function () { hardStop(); });
        navigator.mediaSession.setActionHandler("stop", function () { hardStop(); });
        navigator.mediaSession.setActionHandler("play", function () {
          ensureContextHealthy().catch(function () {});
        });
      } catch (e) {}
    } catch (e2) {}
    notifyNativeKeepAlive(!!(activeId || metroRunning));
  }

  function onAudioLifecycleEvent() {
    ensureContextHealthy().then(function () {
      updateMediaSession();
      notifyNativeKeepAlive(!!(activeId || metroRunning || started));
    }).catch(function () {});
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") onAudioLifecycleEvent();
    else notifyNativeKeepAlive(!!(activeId || metroRunning || started));
  });
  window.addEventListener("pageshow", onAudioLifecycleEvent);
  window.addEventListener("focus", onAudioLifecycleEvent);
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", onAudioLifecycleEvent);
    }
  } catch (e) {}
  document.addEventListener("pointerdown", function () {
    if (started && Tone.context.state !== "running") onAudioLifecycleEvent();
  }, true);

  window.__padApp = {
    i18n: I18N,
    getActiveId: function () { return activeId; },
    getVoiceCount: function () { return voices.size; },
    getFadingCount: function () { return fadingVoices.length; },
    getTimbre: function () { return settings.timbre; },
    getAudioStarted: function () { return started; },
    getContext: function () { return started ? Tone.context.rawContext : null; },
    getSettings: function () { return Object.assign({}, settings); },
    getDefaults: function () { return Object.assign({}, DEFAULTS); },
    getTimbreEQ: function () { return JSON.parse(JSON.stringify(TIMBRE_EQ)); },
    recommendedEQ: function (t) { return Object.assign({}, recommendedEQ(t || settings.timbre)); },
    getMuteGain: function () { return muteGain ? muteGain.gain.value : 1; },
    readOutputLevels: readOutputLevels,
    readChannelLevels: readChannelLevels,
    getBeatLog: function () { return beatLog.slice(); },
    clearBeatLog: function () { beatLog.length = 0; },
    isMetroRunning: function () { return metroRunning; },
    startMetro: async function () {
      await ensureAudio();
      if (!metroRunning) startMetronome();
    },
    stopMetro: function () { stopMetronome(false); },
    toggleMetronome: toggleMetronome,
    fadeSecs: fadeSecs,
    hardStop: hardStop,
    setTimbre: setTimbre,
    applyLive: applyLive,
    resetParam: resetParam,
    applyPanRouting: applyPanRouting,
    applySong: applySong,
    playKeyForce: playKeyForce,
    softStopPad: softStopPad,
    capturePadState: capturePadState,
    restorePadState: restorePadState,
    setTimeSig: setTimeSig,
    snapshotSongFields: snapshotSongFields,
    getNotes: function () { return NOTES.map(function (n) { return { id: n.id, label: n.label, midi: n.midi }; }); },
    getTimbres: function () {
      return TIMBRES.map(function (id) { return { id: id, label: TIMBRE_LABELS[id] || id }; });
    },
    syncAllUI: function () {
      PARAMS.forEach(syncUI);
      syncTimbreUI();
      syncSigUI();
      rebuildBeatDots();
    },
    enhanceAllKnobs: enhanceAllKnobs,
  };
})();
