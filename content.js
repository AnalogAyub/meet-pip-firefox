// Composites Google Meet's video tiles, chat and reactions onto a canvas,
// streams it into one <video>, and lets Firefox's native Picture-in-Picture
// show that. The PiP window's mute button toggles Meet's mic; its pause button
// turns Meet's camera off.
(() => {
  'use strict';
  if (window.__meetPipLoaded) return;
  window.__meetPipLoaded = true;
  // Remove nodes left by a previous instance (extension update or reload).
  document.querySelectorAll('#meet-pip-root').forEach(n => n.remove());

  // Config
  const CONFIG = {
    width: 720,             // composite width when nobody is presenting; height follows the grid
    height: 540,            // composite height outside a call
    presentWidth: 1280,     // composite width while presenting; height follows the slide's aspect ratio
    fps: 24,                // while someone can see the composite
    idleFps: 3,             // while you are looking at Meet itself and the preview is closed
    maxGridTiles: 6,        // tiles shown when nobody is presenting, yours included
    maxStripTiles: 5,       // tiles shown under a presentation, yours included
    showChat: true,
    chatLines: 4,           // most recent messages kept on screen
    chatTtlMs: 10000,       // how long a chat row stays up; longer if a long message needs it to scroll twice
    showTileMic: true,      // mic badge on each participant tile
    pipCornerRadius: 19,    // the PiP window's corner radius in CSS px (macOS), for matching tile corners
    showAnnouncements: true, // also show Meet's screen-reader announcements (chat toasts, raised hands)
    showReactions: true,
    pipMuteTogglesMic: true,     // PiP window mute button -> Meet microphone
    pipPauseTurnsCameraOff: true, // PiP window pause button -> Meet camera off (never on)
    syncIntervalMs: 500,
    debug: false,
  };

  const log = (...a) => CONFIG.debug && console.log('[meet-pip]', ...a);
  let W = CONFIG.width, H = CONFIG.height;   // current composite size; changes with the layout
  let unit = 1;                              // px per layout unit, set with the size
  const u = n => Math.round(n * unit);
  const FONT = '"Google Sans", Roboto, system-ui, sans-serif';

  // Meet adapter
  // Meet's DOM. aria-labels are localized, so buttons are matched by label,
  // then by toolbar order (microphone, camera).
  const MEET = {
    // Asked for several times per sync; one page-wide query per 250ms is enough.
    toggleButtons() {
      const now = performance.now();
      if (now - this.buttonsAt > 250) {
        this.buttons = [...document.querySelectorAll('button[data-is-muted]')];
        this.buttonsAt = now;
      }
      return this.buttons;
    },
    buttons: [],
    buttonsAt: -1e9,
    micButton() {
      const btns = this.toggleButtons();
      return btns.find(b => /mic|mikro|micr/i.test(b.getAttribute('aria-label') || '')) || btns[0] || null;
    },
    camButton() {
      const btns = this.toggleButtons();
      return btns.find(b => /cam|kamera|cámara|caméra|câmera/i.test(b.getAttribute('aria-label') || '')) || btns[1] || null;
    },
    isOff(btn) {
      return !!btn && btn.getAttribute('data-is-muted') === 'true';
    },
    tiles() {
      return document.querySelectorAll('[data-participant-id]');
    },
    inCall() {
      // The lobby has mic/cam buttons but no tiles.
      return this.toggleButtons().length > 0 && this.tiles().length > 0;
    },
    chatMessages() {
      // A message's pin button carries the same id; only the message itself.
      return document.querySelectorAll('[data-message-id]:not(button)');
    },
  };

  // Cached for 2s: reads computed style.
  const tileCache = new WeakMap();
  function tileInfo(video) {
    const now = performance.now();
    const cached = tileCache.get(video);
    if (cached && now - cached.t < 2000) return cached;
    let self = false;
    try {
      const cs = getComputedStyle(video);
      // Only your own preview is mirrored.
      if (cs.transform && cs.transform !== 'none' && new DOMMatrix(cs.transform).a < 0) self = true;
    } catch (e) { /* ignore */ }
    // Only a shared screen's tile has zoom and pop-out buttons. The text check
    // covers Meet renaming those icons.
    const tile = video.closest('[data-participant-id]');
    const icons = tileIcons(tile);
    const presentation = icons.has('zoom_in') || icons.has('open_in_new') ||
      /presentation|presenting|präsentation|présentation|presentación/i.test(tile?.textContent || '');
    const info = { t: now, self, presentation: presentation && !self };
    tileCache.set(video, info);
    return info;
  }

  // Meet's icons are ligatures: <i>mic_off</i>.
  function tileIcons(tile) {
    const names = new Set();
    if (tile) for (const icon of tile.querySelectorAll('i')) names.add(icon.textContent.trim());
    return names;
  }
  // Each tile has a "mute this person" button whose icon is mic_none while
  // they are unmuted and mic_off once they are muted. null: can't tell.
  function tileMuted(tile) {
    const icons = tileIcons(tile);
    if (icons.has('mic_off')) return true;
    if (icons.has('mic_none') || icons.has('mic')) return false;
    return null;
  }

  function tileName(tile) {
    return tile?.querySelector('span.notranslate')?.textContent.trim() || '';
  }

  // Who is speaking. Meet animates a tile's voice indicator by changing its
  // classes several times a second while that person talks, so a burst of
  // class changes there marks the speaker. `tile` stays set after they stop,
  // so their tile keeps its place until someone else talks.
  const speaker = { tile: null, t: 0 };
  const bursts = new WeakMap();
  const speakObserver = new MutationObserver(records => {
    const now = performance.now();
    for (const rec of records) {
      const el = rec.target;
      if (el.getAttribute('jsname') !== 'QgSmzd' && !el.closest('[jsname="QgSmzd"], [jsname="qmYRK"]') &&
          !el.querySelector(':scope > [jsname="qmYRK"], :scope > * > [jsname="qmYRK"]')) continue;
      const tile = el.closest('[data-participant-id]');
      if (!tile) continue;
      let b = bursts.get(tile);
      if (!b || now - b.start > 1000) bursts.set(tile, b = { start: now, n: 0 });
      if (++b.n < 3) continue;
      // Not you (your tile has no "mute this person" button) or a shared screen.
      if (tile !== speaker.tile) {
        if (!tile.querySelector('[jsname="LgbsSe"]') || tileIcons(tile).has('zoom_in')) continue;
        speaker.tile = tile;
      }
      speaker.t = now;
    }
  });
  // Watch class changes inside tiles only; page-wide, Meet makes far too many.
  // Returns the number of tiles.
  let watchedTiles = new WeakSet();
  function watchTiles() {
    const tiles = MEET.tiles();
    for (const tile of tiles) {
      if (watchedTiles.has(tile)) continue;
      watchedTiles.add(tile);
      speakObserver.observe(tile, { attributes: true, attributeFilter: ['class'], subtree: true });
    }
    return tiles.length;
  }
  // Puts the last speaker in the first `limit` entries if they are further down.
  function withSpeaker(list, limit) {
    const shown = list.slice(0, limit);
    const i = list.findIndex(e => e.tile === speaker.tile);
    if (i >= limit) shown[limit - 1] = list[i];
    return shown;
  }

  // Tiles to draw, largest first. Needs layout, so sync() rebuilds it twice a
  // second instead of every frame.
  let sources = [];
  // Your own tile: always drawn, with your mic and camera state on it.
  const self = { self: true, video: null };
  let othersCount = 0;   // participant tiles other than yours, with or without video
  function refreshSources() {
    const byTile = new Map();
    let selfVideo = null;
    for (const v of document.querySelectorAll('video')) {
      if (v === mirror) continue;
      // Keep Firefox from picking Meet's own tiles for PiP.
      if (!v.disablePictureInPicture) v.disablePictureInPicture = true;
      if (v.readyState < 2 || !v.videoWidth || v.paused) continue;
      if (!v.checkVisibility()) continue;
      const r = v.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const info = tileInfo(v);
      if (info.self) { if (!selfVideo) selfVideo = v; continue; }
      const tile = v.closest('[data-participant-id]');
      const entry = { video: v, tile, area: r.width * r.height, presentation: info.presentation, muted: info.presentation ? null : tileMuted(tile), name: tileName(tile) };
      // A tile can hold two videos of the same person; keep the larger.
      const key = tile || v;
      if (!byTile.has(key) || byTile.get(key).area < entry.area) byTile.set(key, entry);
    }
    // The last speaker gets a tile even with their camera off.
    const sp = speaker.tile;
    if (sp && sp.isConnected && !byTile.has(sp)) {
      byTile.set(sp, { video: null, tile: sp, area: 0, presentation: false, muted: tileMuted(sp), name: tileName(sp) });
    }
    sources = [...byTile.values()].sort((a, b) => b.area - a.area);
    self.video = selfVideo;
    othersCount = Math.max(0, watchTiles() - 1);
  }
  // Per frame: cheap liveness checks only.
  function sourceVideos() {
    return sources.filter(e => e.video ? e.video.isConnected && e.video.readyState >= 2 && e.video.videoWidth && !e.video.paused : e.tile.isConnected);
  }

  // Chat + reactions
  const chat = [];            // { sender, text, t }
  const seenChat = new Set();
  const reactions = [];       // { emoji, t, x }
  const EMOJI_RE = /^(\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
  // Announcements about Meet's own UI, not from people.
  const ANNOUNCE_NOISE = /microphone|camera|\bpin|unpin|\bmute|captions|recording|press |shortcut|keyboard|loading|presentation|presenting|main screen|\bscreen\b|\btile|layout|spotlight|connect|network|quality|picture-in-picture|^\d+ results?\b|no results|^you reacted|panel (is )?(now )?(open|closed)|side panel|\b(joined|left)( the (call|meeting))?\.?$|transcri|taking notes|^reducing noise/i;

  // Meet reports one message several ways (the chat panel, a toast, a
  // screen-reader line) and repeats them, so anything matching a row from the
  // last two minutes is the same message. Only two chat-panel messages, which
  // have their own ids, can repeat a text.
  function sameText(a, b) {
    if (a === b) return true;
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    return short.length >= 12 && long.includes(short);
  }
  // Every report of a chat message and what became of it, for working out
  // why a row did or didn't appear. The "debug" command writes it to the page.
  const chatLog = [];
  function note(key, sender, text, result) {
    chatLog.push({ at: new Date().toISOString().slice(11, 23), source: key.slice(0, 2) === 'm:' ? 'panel' : 'announced', key: key.slice(0, 60), sender, text, result });
    if (chatLog.length > 60) chatLog.shift();
  }
  function pushChat(key, sender, text, fromPanel = false) {
    if (seenChat.has(key)) { note(key, sender, text, 'same key, ignored'); return; }
    seenChat.add(key);
    if (seenChat.size > 500) seenChat.clear();
    text = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!text) { note(key, sender, text, 'empty, ignored'); return; }
    const now = Date.now();
    const same = chat.find(m => now - m.t < 120000 && !(fromPanel && m.fromPanel) && sameText(m.text, text));
    if (same) {
      if (sender && !same.sender) { same.sender = sender; chatVersion++; }
      note(key, sender, text, 'same text as an existing row, merged');
      return;
    }
    chat.push({ sender, text, t: now, fromPanel });
    chatVersion++;
    if (chat.length > 30) chat.shift();
    note(key, sender, text, 'new row');
  }

  // A message element also holds its hover actions: icon names ("keep") and
  // tooltips ("Pin message"). Only text outside those is the message.
  const NOT_MESSAGE = 'i, button, [role="button"], [role="tooltip"]';
  function messageText(el) {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement.closest(NOT_MESSAGE)) parts.push(node.data);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // Chat panel messages (in the DOM once the panel has been opened).
  function scanChat() {
    if (!CONFIG.showChat) return;
    for (const el of MEET.chatMessages()) {
      const id = 'm:' + el.getAttribute('data-message-id');
      if (seenChat.has(id)) continue;
      // Meet keeps the text in its own element; fall back to everything that
      // isn't a hover action.
      const body = el.querySelector('[jsname="dTKtvb"]');
      const text = body ? body.textContent.replace(/\s+/g, ' ').trim() : messageText(el);
      if (!text) continue;
      const sender = el.closest('[data-sender-name]')?.getAttribute('data-sender-name') || '';
      pushChat(id, sender, text, true);
    }
  }

  function pushReaction(emoji) {
    const now = performance.now();
    if (reactions.length > 14) reactions.shift();
    reactions.push({ emoji, t: now, x: 0.12 + Math.random() * 0.76 });
  }

  // Meet reports one reaction several ways: aria-live announcements and
  // inserted emoji nodes, each possibly more than once. Repeats from one
  // source within 300ms are the same reaction, and a report from the other
  // source within 4s cancels against the first.
  const unmatched = { live: [], dom: [] };
  const lastReport = { live: {}, dom: {} };
  function react(emoji, src) {
    const now = performance.now();
    if (now - (lastReport[src][emoji] || -1e9) < 300) return;
    lastReport[src][emoji] = now;
    const other = unmatched[src === 'live' ? 'dom' : 'live'];
    while (other.length && now - other[0].t > 4000) other.shift();
    const i = other.findIndex(e => e.emoji === emoji);
    if (i >= 0) { other.splice(i, 1); return; }
    const mine = unmatched[src];
    if (mine.length > 20) mine.shift();
    mine.push({ emoji, t: now });
    pushReaction(emoji);
  }

  const seenEmojiNodes = new WeakSet();
  function emojiOf(node) {
    if (node.nodeType !== 1) return '';
    if (node.closest('button, [role="dialog"], [role="menu"], [role="listbox"], [role="textbox"], [contenteditable], [data-message-id], #meet-pip-root')) return '';
    const img = node.matches('img[alt]') ? node : node.querySelector('img[alt]');
    const cand = (img ? img.getAttribute('alt') : (node.textContent || '')).trim();
    if (!cand || cand.length > 12 || !EMOJI_RE.test(cand)) return '';
    // A wrapper and its child can both show up as added nodes.
    for (let a = img || node; a; a = a.parentElement) { if (seenEmojiNodes.has(a)) return ''; }
    seenEmojiNodes.add(img || node);
    return cand;
  }

  // An announced chat message arrives as separate nodes: sender, time, text.
  // Collect a region's pieces for a moment and show them as one row.
  const TIME_RE = /^\d{1,2}[:.]\d{2}(\s?[ap]\.?m\.?)?$/i;
  const liveParts = new Map();
  const SAYS_RE = /^(.{1,60}?) says(?: in chat)?: (.+)$/i;
  function queueLive(region, text) {
    let parts = liveParts.get(region);
    if (!parts) {
      liveParts.set(region, parts = []);
      setTimeout(() => {
        liveParts.delete(region);
        // "Name says in chat: text" is complete by itself; the other pieces
        // are usually the same name and text again.
        const said = parts.map(p => p.match(SAYS_RE)).filter(Boolean);
        for (const [, sender, body] of said) pushChat('a:' + sender + body, sender, body);
        const rest = parts.filter(p => !SAYS_RE.test(p) && !said.some(([, sender, body]) => p === sender || body.includes(p)));
        // Someone else's message has a header: their name, then the time.
        // Your own has neither, so without a time there is no sender.
        const sender = rest.length > 2 && TIME_RE.test(rest[1]) && rest[0].length <= 40 ? rest.shift() : '';
        const body = rest.filter(p => !TIME_RE.test(p)).join(' ');
        if (body) pushChat('a:' + sender + body, sender, body);
      }, 250);
    }
    if (!parts.includes(text)) parts.push(text);
  }
  function textPieces(node) {
    if (node.nodeType === 3) return [node.data.trim()];
    if (node.nodeType !== 1) return [];
    const out = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.parentElement.closest(NOT_MESSAGE)) out.push(walker.currentNode.data.trim());
    }
    return out;
  }

  // Chat toasts and raised hands arrive in aria-live regions;
  // reactions arrive as inserted emoji nodes.
  const observer = new MutationObserver(records => {
    // A very large batch is a re-render, not a reaction.
    if (!state.inCall || records.length > 300) return;
    for (const rec of records) {
      if (rec.type === 'childList' && !rec.addedNodes.length) continue;
      const host = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement;
      if (!host || root.contains(host)) continue;
      const live = host.closest('[aria-live]');
      if (live) {
        // A message's pin button and its icon name ("keep") are not the message.
        if (host.closest(NOT_MESSAGE)) continue;
        // Search counts and the like from pickers and menus.
        if (live.closest('[role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [role="search"], form')) continue;
        const text = (rec.type === 'characterData' ? rec.target.data : [...rec.addedNodes].map(n => n.textContent).join(' ')).trim();
        if (text.length < 3 || text.length > 240) continue;
        if (CONFIG.showReactions) {
          const m = text.match(/\p{Extended_Pictographic}/u);
          if (m && text.length < 60) react(m[0], 'live');
        }
        // Meet's raise-hand gesture: drives the ring on your tile, not a chat row.
        if (/^hand detected/i.test(text)) { note('a:' + text, '', text, 'hand gesture started'); handDetected(); continue; }
        if (/^hand no longer detected/i.test(text)) { note('a:' + text, '', text, 'hand gesture cancelled'); handFinished(false); continue; }
        if (ANNOUNCE_NOISE.test(text)) note('a:' + text, '', text, 'Meet interface announcement, not shown');
        if (CONFIG.showChat && CONFIG.showAnnouncements && !ANNOUNCE_NOISE.test(text)) {
          const pieces = rec.type === 'characterData' ? [text] : [...rec.addedNodes].flatMap(textPieces);
          for (const piece of pieces) if (piece) queueLive(live, piece);
        }
        continue;
      }
      if (!CONFIG.showReactions) continue;
      for (const node of rec.addedNodes) {
        const emoji = emojiOf(node);
        if (emoji) react(emoji, 'dom');
      }
    }
  });

  // Compositor
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  // The PiP window follows the video's aspect ratio. Keep dimensions even.
  function setSize(w, h, newUnit = unit) {
    w = Math.round(w / 2) * 2;
    h = Math.round(h / 2) * 2;
    if (newUnit !== unit) { unit = newUnit; applyUnit(); }
    if (w === W && h === H) return;
    W = canvas.width = w;
    H = canvas.height = h;
  }

  // Corner radius for tiles. The Sine mod reports the PiP window's width; with
  // it, tiles follow the window's own rounded corners (an inner corner is the
  // outer one less the gap between them). Without it, a fixed radius.
  let pipWidth = 0;
  function tileRadius(w, h) {
    const r = pipWidth ? Math.max(u(8), CONFIG.pipCornerRadius * W / pipWidth - u(8)) : u(14);
    return Math.min(r, Math.min(w, h) * 0.3);
  }
  function drawCover(v, x, y, w, h) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = Math.max(w / vw, h / vh);
    const sw = w / scale, sh = h / scale;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, tileRadius(w, h));
    ctx.clip();
    ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
    ctx.restore();
  }

  function drawContain(v, x, y, w, h) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = Math.min(w / vw, h / vh);
    const dw = vw * scale, dh = vh * scale;
    ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  const state = { micOff: false, camOff: false, handUp: false, inCall: false };

  // Raise-hand gesture. Meet announces "Hand detected", then raises your hand
  // if you hold it up long enough, or announces "Hand no longer detected".
  // `since` is set while the gesture is counting; `ms` is how long Meet took
  // last time, measured, so the ring fills at Meet's own pace.
  const hand = { since: 0, doneAt: -1e9, ms: 3000, timer: 0 };
  try { hand.ms = +localStorage.getItem('meet-pip-hand-ms') || hand.ms; } catch (e) { /* ignore */ }
  function handRaised() {
    const btn = labelButton(/^(raise|lower) hand/i);
    return !!btn && (btn.getAttribute('aria-pressed') === 'true' || /^lower hand/i.test(btn.getAttribute('aria-label')));
  }
  function handDetected() {
    if (hand.since || handRaised()) return;
    hand.since = performance.now();
    hand.timer = setInterval(() => {
      const waited = performance.now() - hand.since;
      if (handRaised()) {
        hand.ms = Math.max(800, Math.min(8000, Math.round(waited)));
        try { localStorage.setItem('meet-pip-hand-ms', hand.ms); } catch (e) { /* ignore */ }
        handFinished(true);
      } else if (waited > hand.ms + 4000) {
        handFinished(false);
      }
    }, 100);
  }
  function handFinished(raised) {
    if (!hand.since) return;
    clearInterval(hand.timer);
    hand.since = 0;
    if (raised) { hand.doneAt = performance.now(); state.handUp = true; }
  }

  let CHAT_FONT, CHAT_LH, CHAT_PAD;
  function applyUnit() {
    CHAT_FONT = u(27); CHAT_LH = u(36); CHAT_PAD = u(14);
  }
  applyUnit();
  // Recompute only when the chat, width or second (for expiry) changes.
  let chatVersion = 0, chatCacheKey = '', chatCache = { rows: [], height: 0 };
  function layoutChat() {
    const key = chatVersion + ':' + W + ':' + unit + ':' + Math.floor(Date.now() / 1000);
    if (key !== chatCacheKey) { chatCacheKey = key; chatCache = computeChatLayout(); }
    return chatCache;
  }
  // One line per message: the sender stays put and a message too wide for
  // the rest of the row scrolls past twice. A long message gets longer loops.
  const CHAT_LOOPS = 2;
  function computeChatLayout() {
    if (!CONFIG.showChat) return { rows: [], height: 0 };
    const now = Date.now();
    const avail = W - u(24) - CHAT_PAD * 2;
    const rows = [];
    for (const m of chat) {
      ctx.font = `700 ${CHAT_FONT}px ${FONT}`;
      // The sender never takes more than 40% of the row.
      let sender = m.sender ? m.sender + ':' : '';
      while (sender.length > 4 && ctx.measureText(sender).width > avail * 0.4) sender = sender.slice(0, -3).trimEnd() + '…:';
      const senderW = sender ? ctx.measureText(sender + ' ').width : 0;
      ctx.font = `500 ${CHAT_FONT}px ${FONT}`;
      const overflow = Math.max(0, ctx.measureText(m.text).width - (avail - senderW));
      const loopMs = Math.max(CONFIG.chatTtlMs / CHAT_LOOPS, 2000 + overflow / u(170) * 1000);
      const ttl = overflow ? Math.min(30000, loopMs * CHAT_LOOPS) : CONFIG.chatTtlMs;
      if (now - m.t < ttl) rows.push({ m, sender, senderW, overflow, loopMs: ttl / CHAT_LOOPS });
    }
    rows.splice(0, Math.max(0, rows.length - CONFIG.chatLines));
    return { rows, height: rows.length ? rows.length * (CHAT_LH + CHAT_PAD + u(8)) + u(4) : 0 };
  }

  function drawChat(layout, top) {
    let y = top + u(4);
    const h = CHAT_LH + CHAT_PAD, now = Date.now();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const row of layout.rows) {
      const left = u(12) + CHAT_PAD, ly = y + h / 2;
      ctx.fillStyle = '#2b2c2f';
      ctx.beginPath();
      ctx.roundRect(u(12), y, W - u(24), h, u(14));
      ctx.fill();
      if (row.sender) {
        ctx.font = `700 ${CHAT_FONT}px ${FONT}`;
        ctx.fillStyle = '#8ab4f8';
        ctx.fillText(row.sender, left, ly);
      }
      // Each loop: hold 1s, scroll to the end, hold 1s.
      let shift = 0;
      if (row.overflow) {
        const inLoop = (now - row.m.t) % row.loopMs;
        shift = row.overflow * Math.max(0, Math.min(1, (inLoop - 1000) / (row.loopMs - 2000)));
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(left + row.senderW, y, W - u(24) - CHAT_PAD * 2 - row.senderW, h);
      ctx.clip();
      ctx.font = `500 ${CHAT_FONT}px ${FONT}`;
      ctx.fillStyle = '#e8eaed';
      ctx.fillText(row.m.text, left + row.senderW - shift, ly);
      ctx.restore();
      y += h + u(8);
    }
  }

  function drawReactions(bottom) {
    const now = performance.now();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${u(92)}px "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    for (let i = reactions.length - 1; i >= 0; i--) {
      const r = reactions[i];
      const age = (now - r.t) / 3200;
      if (age >= 1) { reactions.splice(i, 1); continue; }
      ctx.globalAlpha = age < 0.7 ? 1 : (1 - age) / 0.3;
      ctx.fillText(r.emoji, r.x * W + Math.sin(age * 9 + r.x * 20) * u(14), bottom - u(70) - age * Math.min(u(620), bottom * 0.7));
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  // Material mic, mic_off, videocam, videocam_off (24x24).
  const ICONS = {
    micOn: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
    micOff: 'M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z',
    camOn: 'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z',
    camOff: 'M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z',
  };
  const iconPaths = {};
  // Dark with a light glyph when on, pink with a dark glyph when off.
  function statusBlock(x, y, w, h, on, icon) {
    ctx.fillStyle = on ? '#3c4043' : '#f9dedc';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(w, h) / 2);
    ctx.fill();
    const path = iconPaths[icon] || (iconPaths[icon] = new Path2D(ICONS[icon]));
    const size = Math.min(w, h) * 0.66;
    ctx.save();
    ctx.translate(x + (w - size) / 2, y + (h - size) / 2);
    ctx.scale(size / 24, size / 24);
    ctx.fillStyle = on ? '#e8eaed' : '#8c1d18';
    ctx.fill(path);
    ctx.restore();
  }
  // Mic badge in a tile's top-right corner.
  function drawTile(entry, x, y, w, h) {
    if (entry.self) { drawSelf(x, y, w, h); return; }
    const isSpeaker = entry.tile && entry.tile === speaker.tile;
    if (entry.video) {
      drawCover(entry.video, x, y, w, h);
    } else {
      // Camera off: a plain tile with the name.
      ctx.fillStyle = '#2b2c2f';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, tileRadius(w, h));
      ctx.fill();
    }
    if (isSpeaker && entry.name) {
      // Name, bottom left. One too long for the tile scrolls round slowly.
      const fs = Math.max(u(18), Math.min(u(24), w * 0.085)), pad = fs * 0.45;
      ctx.font = `500 ${fs}px ${FONT}`;
      const tw = ctx.measureText(entry.name).width;
      const boxW = Math.min(tw, w - pad * 4);
      const bx = x + pad, by = y + h - pad - fs * 1.5;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW + pad * 2, fs * 1.5, fs * 0.4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx + pad, by, boxW, fs * 1.5);
      ctx.clip();
      const ty = by + fs * 0.78;
      if (tw <= boxW) {
        ctx.fillText(entry.name, bx + pad, ty);
      } else {
        const lap = tw + fs * 2;
        const shift = (performance.now() / 1000 * fs * 1.2) % lap;
        ctx.fillText(entry.name, bx + pad - shift, ty);
        ctx.fillText(entry.name, bx + pad - shift + lap, ty);
      }
      ctx.restore();
    }
    if (isSpeaker && performance.now() - speaker.t < 2500) {
      // Outline while they are talking.
      const lw = u(4);
      ctx.strokeStyle = '#8ab4f8';
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, tileRadius(w, h) - lw / 2);
      ctx.stroke();
    }
    if (!CONFIG.showTileMic || entry.muted === null) return;
    const d = badgeSize(w), m = d * 0.22;
    statusBlock(x + w - d - m, y + m, d, d, !entry.muted, entry.muted ? 'micOff' : 'micOn');
  }
  const badgeSize = w => Math.max(u(34), Math.min(u(52), w * 0.2));
  // Your preview, mirrored as Meet shows it, with mic and camera badges.
  function drawSelf(x, y, w, h) {
    const v = self.video;
    if (v && v.isConnected && v.readyState >= 2 && v.videoWidth && !v.paused && !state.camOff) {
      ctx.save();
      ctx.translate(2 * x + w, 0);
      ctx.scale(-1, 1);
      drawCover(v, x, y, w, h);
      ctx.restore();
    } else {
      ctx.fillStyle = '#2b2c2f';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, tileRadius(w, h));
      ctx.fill();
      ctx.fillStyle = '#9aa0a6';
      ctx.font = `500 ${Math.max(u(20), Math.min(u(30), w * 0.11))}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('You', x + w / 2, y + h / 2);
      ctx.textAlign = 'left';
    }
    const d = badgeSize(w), m = d * 0.22;
    statusBlock(x + w - d - m, y + m, d, d, !state.micOff, state.micOff ? 'micOff' : 'micOn');
    statusBlock(x + w - d * 2 - m * 1.6, y + m, d, d, !state.camOff, state.camOff ? 'camOff' : 'camOn');
    drawHand(x, y, w, h, d, m);
  }
  // While the gesture counts: a ring in the middle of your tile filling
  // clockwise in green. Once raised: a solid green hand for a moment, then a
  // small one in the top-left corner for as long as your hand stays up.
  const GREEN = '#34a853';
  function drawHand(x, y, w, h, d, m) {
    const now = performance.now();
    const counting = hand.since > 0, justRaised = now - hand.doneAt < 1500;
    if (!counting && !justRaised && !state.handUp) return;
    const big = counting || justRaised;
    const r = big ? Math.min(w, h) * 0.17 : d / 2;
    const cx = big ? x + w / 2 : x + m + r, cy = big ? y + h / 2 : y + m + r;
    ctx.fillStyle = counting ? 'rgba(0, 0, 0, 0.6)' : GREEN;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    if (counting) {
      const lw = r * 0.16, p = Math.min(1, (now - hand.since) / hand.ms);
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.beginPath();
      ctx.arc(cx, cy, r - lw / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = GREEN;
      ctx.beginPath();
      ctx.arc(cx, cy, r - lw / 2, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
    ctx.font = `${r * 1.05}px "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✋', cx, cy + r * 0.06);
    ctx.textAlign = 'left';
  }

  function drawMessage(message, areaH) {
    ctx.fillStyle = '#9aa0a6';
    ctx.font = `500 ${u(40)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message, W / 2, areaH / 2);
    ctx.textAlign = 'left';
  }

  const gridCols = n => n <= 1 ? 1 : n <= 4 ? 2 : 3;
  // Grid of equal centre-cropped cells. A cell is a tile entry or { more: N }.
  function drawGrid(cells, top, areaH) {
    const n = cells.length;
    const cols = gridCols(n);
    const gap = u(8);
    const rows = Math.ceil(n / cols);
    const cw = (W - gap * (cols + 1)) / cols;
    const ch = Math.min((areaH - gap * (rows - 1)) / rows, cw * 16 / 9);
    const blockH = rows * ch + (rows - 1) * gap;
    const y0 = top + (areaH - blockH) / 2;
    cells.forEach((cell, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const inRow = r === rows - 1 ? n - r * cols : cols;
      const rowW = inRow * cw + (inRow - 1) * gap;
      const x = (W - rowW) / 2 + c * (cw + gap), y = y0 + r * (ch + gap);
      if (!cell.more) { drawTile(cell, x, y, cw, ch); return; }
      ctx.fillStyle = '#2b2c2f';
      ctx.beginPath();
      ctx.roundRect(x, y, cw, ch, tileRadius(cw, ch));
      ctx.fill();
      ctx.fillStyle = '#e8eaed';
      ctx.font = `500 ${u(44)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${cell.more} more`, x + cw / 2, y + ch / 2);
      ctx.textAlign = 'left';
    });
  }

  // Presenting: slide at full width and its own aspect ratio, chat under it,
  // then one row with the others' tiles (left) and yours (right).
  function composePresenting(stage, rest) {
    const v = stage.video;
    const aspect = Math.max(0.6, Math.min(2.4, v.videoWidth / v.videoHeight));
    const w = CONFIG.presentWidth;
    const presH = Math.round(w / aspect);
    // Chat wraps against the width, so size in two steps.
    setSize(w, W === w ? H : presH, w / 960);
    const rowH = u(200);
    const gap = u(8);
    const chatLayout = layoutChat();
    setSize(w, presH + chatLayout.height + rowH + gap * 2, w / 960);

    ctx.fillStyle = '#131314';
    ctx.fillRect(0, 0, W, H);
    drawContain(v, 0, 0, W, presH);
    if (CONFIG.showReactions && reactions.length) drawReactions(presH);
    if (chatLayout.height) drawChat(chatLayout, presH);

    const rowY = H - rowH - gap;
    // Square tiles, narrower if they would not all fit.
    const tw = Math.min(rowH, Math.floor((W - gap) / (rest.length + 1)) - gap);
    rest.forEach((entry, i) => drawTile(entry, gap + i * (tw + gap), rowY, tw, rowH));
    drawTile(self, W - gap - tw, rowY, tw, rowH);
  }

  function compose() {
    if (!state.inCall) {
      setSize(CONFIG.width, CONFIG.height, CONFIG.width / 720);
      ctx.fillStyle = '#131314';
      ctx.fillRect(0, 0, W, H);
      drawMessage('Not in a call', H);
      return;
    }

    const videos = sourceVideos();
    const stageIdx = videos.findIndex(v => v.presentation);
    if (stageIdx >= 0) {
      composePresenting(videos[stageIdx], withSpeaker(videos.filter((_, i) => i !== stageIdx), CONFIG.maxStripTiles - 1));
      return;
    }

    // Height follows the grid: 4:5 tiles, as many rows as needed.
    const w = CONFIG.width;
    setSize(w, H, w / 720);
    const chatLayout = layoutChat();
    // Others first, then "+N more" if they don't all fit, then you.
    const room = CONFIG.maxGridTiles - 1;
    const over = videos.length > room;
    const shown = over ? withSpeaker(videos, room - 1) : videos;
    const cells = [...shown];
    if (over) cells.push({ more: Math.max(videos.length, othersCount) - shown.length });
    cells.push(self);
    const cols = gridCols(cells.length), rows = Math.ceil(cells.length / cols), gap = u(8);
    const cellH = (w - gap * (cols + 1)) / cols * 1.25;
    const areaH = gap + rows * cellH + (rows - 1) * gap;   // space for video
    setSize(w, areaH + chatLayout.height + gap, w / 720);
    ctx.fillStyle = '#131314';
    ctx.fillRect(0, 0, W, H);
    drawGrid(cells, gap, areaH - gap);
    if (CONFIG.showReactions && reactions.length) drawReactions(areaH);
    if (chatLayout.height) drawChat(chatLayout, areaH);
  }

  // Docked button
  // Meet's toolbar re-renders and drops foreign nodes, so the button is
  // fixed-position over the bottom bar. The mirror video stays in the page,
  // transparent, because Firefox only offers PiP for a laid-out video.
  const root = document.createElement('div');
  root.id = 'meet-pip-root';
  root.innerHTML = `
    <video id="meet-pip-mirror" autoplay playsinline></video>
    <button type="button" id="meet-pip-dock" title="Picture-in-Picture" aria-label="Picture-in-Picture">
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <path fill="currentColor" d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/>
      </svg>
    </button>
  `;
  const dock = root.querySelector('#meet-pip-dock');
  const mirror = root.querySelector('video');

  const stream = canvas.captureStream(CONFIG.fps);
  let audioCtx = null;
  function attachSilentAudio() {
    // Firefox only offers PiP for videos with an audio track. An unconnected
    // destination node gives a silent one.
    try {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      stream.addTrack(dest.stream.getAudioTracks()[0]);
    } catch (e) {
      console.warn('[meet-pip] could not attach silent audio track; PiP eligibility may fail', e);
    }
  }
  attachSilentAudio();
  mirror.srcObject = stream;
  mirror.muted = false;

  // The AudioContext can start suspended until a user gesture.
  document.addEventListener('click', () => { audioCtx?.state === 'suspended' && audioCtx.resume(); }, true);

  // PiP -> Meet controls
  // Firefox's PiP player sets `muted` and calls pause() on the source video.
  // After clicking a Meet button, hold off syncing Meet's state back until its
  // DOM has updated.
  let holdMuteSyncUntil = 0;
  function clickMic() {
    const btn = MEET.micButton();
    if (!btn) return false;
    holdMuteSyncUntil = performance.now() + 1500;
    btn.click();
    setTimeout(sync, 150);
    return true;
  }
  mirror.addEventListener('volumechange', () => {
    if (!CONFIG.pipMuteTogglesMic || !state.inCall) return;
    const btn = MEET.micButton();
    if (btn && mirror.muted !== MEET.isOff(btn)) {
      log('PiP mute toggled -> clicking Meet mic button');
      clickMic();
    }
  });

  let resuming = false;
  mirror.addEventListener('pause', () => {
    // Removing the element also fires `pause`; ignore that.
    if (resuming || !state.inCall || !mirror.isConnected) return;
    if (CONFIG.pipPauseTurnsCameraOff) {
      // Off only. Turning the camera on needs a new camera grant, which Firefox
      // withholds from a tab that is not selected.
      const btn = MEET.camButton();
      if (btn && !MEET.isOff(btn)) {
        log('PiP pause -> turning Meet camera off');
        btn.click();
        setTimeout(sync, 150);
      }
    }
    // Keep the mirror playing or the PiP window freezes.
    resuming = true;
    mirror.play().catch(() => {}).finally(() => { resuming = false; });
  });

  // Opens the PiP window, or closes it if this button opened it.
  async function togglePip() {
    if (document.pictureInPictureElement === mirror) {
      document.exitPictureInPicture().catch(() => {});
      return;
    }
    try {
      await mirror.requestPictureInPicture();
    } catch (e) {
      // dom.media-pip.enabled is off.
      dock.title = 'Press ⌘⇧] (Ctrl+Shift+]) for Picture-in-Picture';
      console.warn('[meet-pip] requestPictureInPicture unavailable; use the keyboard shortcut', e);
    }
  }
  dock.addEventListener('click', togglePip);

  // Commands from the companion Sine mod, which adds real buttons to the PiP
  // window. They arrive as `meet-pip-command` events carrying JSON; mic and
  // camera state goes back as `meet-pip-state`. Without the mod nothing sends
  // or listens.
  const outsideTiles = b => b && !b.closest('[data-participant-id]');
  function iconButton(...names) {
    for (const icon of document.querySelectorAll('button i')) {
      if (names.includes(icon.textContent.trim()) && outsideTiles(icon)) return icon.closest('button');
    }
    return null;
  }
  function labelButton(re) {
    return [...document.querySelectorAll('button[aria-label]')].find(b => re.test(b.getAttribute('aria-label')) && outsideTiles(b)) || null;
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function until(find, ms) {
    const end = performance.now() + ms;
    for (;;) {
      const found = find();
      if (found || performance.now() > end) return found;
      await wait(100);
    }
  }
  // The "More emojis" picker only renders the rows in view, so scroll through
  // it until the wanted emoji turns up. Closes the picker if it never does.
  async function findInPicker(find) {
    const more = iconButton('add_reaction');
    if (!more) return null;
    const dialog = () => document.getElementById(more.getAttribute('aria-controls'));
    if (!dialog()) more.click();
    const list = await until(() => dialog()?.querySelector('[role="menu"]'), 2000);
    if (!list) return null;
    let scroller = list;
    while (scroller && scroller !== dialog() && scroller.scrollHeight <= scroller.clientHeight + 10) scroller = scroller.parentElement;
    for (let i = 0; i < 80; i++) {
      const btn = find(dialog());
      if (btn) return btn;
      const before = scroller.scrollTop;
      scroller.scrollTop += Math.max(80, scroller.clientHeight - 40);
      await wait(60);
      if (scroller.scrollTop === before) break;   // reached the end
    }
    if (dialog()) more.click();
    return null;
  }
  const COMMANDS = {
    hello: () => sendState(true),
    window({ width }) {
      if (width > 100 && width < 5000) pipWidth = width;
    },
    // Diagnostics: copy(document.documentElement.dataset.meetPipLog) in the console.
    debug() {
      document.documentElement.dataset.meetPipLog = JSON.stringify({ version: '0.4.18', rows: chat, log: chatLog }, null, 1);
    },
    mic: () => clickMic(),
    cam() {
      MEET.camButton()?.click();
      setTimeout(sync, 150);
    },
    async react({ emoji }) {
      if (typeof emoji !== 'string' || emoji.length > 16 || !EMOJI_RE.test(emoji)) return;
      // Meet's reaction buttons carry data-emoji. Compare without the
      // variation selector, which a typed emoji may or may not include.
      const plain = e => (e || '').replace(/\uFE0F/g, '');
      const want = plain(emoji);
      const find = scope => [...scope.querySelectorAll('button[data-emoji]')].find(b => plain(b.dataset.emoji) === want && outsideTiles(b));
      let btn = find(document);
      // The bar's own button is a toggle (aria-pressed), so only click it to
      // open the bar, never when it is already open.
      const bar = iconButton('mood') || labelButton(/^send a reaction/i);
      if (!btn && bar && bar.getAttribute('aria-pressed') !== 'true') {
        bar.click();
        btn = await until(() => find(document), 1500);
      }
      if (btn) { btn.click(); return; }
      btn = await findInPicker(find);
      if (!btn) return;
      btn.click();
      // Meet leaves the picker open after a pick; close it.
      await wait(250);
      const more = iconButton('add_reaction');
      if (more && document.getElementById(more.getAttribute('aria-controls'))) more.click();
    },
    async chat({ text }) {
      text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!text) return;
      // Only the chat box; Meet has other text fields (Gemini).
      const box = () => [...document.querySelectorAll('textarea')].find(t => /send a message|message to everyone/i.test(t.getAttribute('aria-label') || t.placeholder || ''));
      let field = box(), opener = null;
      if (!field) {
        opener = labelButton(/^chat with everyone/i) || iconButton('chat', 'chat_bubble');
        opener?.click();
        field = await until(box, 2500);
      }
      if (!field) return;
      field.focus();
      field.value = text;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      const send = await until(() => [...document.querySelectorAll('button')].find(b =>
        !b.disabled && /^send a message/i.test(b.getAttribute('aria-label') || '')), 1000);
      send?.click();
      await wait(300);
      opener?.click();
    },
    leave: () => (labelButton(/^leave call/i) || iconButton('call_end'))?.click(),
  };
  const seenCommands = new Set();
  document.addEventListener('meet-pip-command', e => {
    let c;
    try { c = JSON.parse(e.detail); } catch (err) { return; }
    if (!state.inCall || !c || !Object.hasOwn(COMMANDS, c.cmd)) return;
    // The same command can be delivered more than once.
    if (c.id) {
      if (seenCommands.has(c.id)) return;
      seenCommands.add(c.id);
      if (seenCommands.size > 200) seenCommands.clear();
    }
    Promise.resolve(COMMANDS[c.cmd](c)).catch(err => log('command failed', c.cmd, err));
  });
  let lastState = '';
  function sendState(force) {
    const now = JSON.stringify({ mic: !state.micOff, cam: !state.camOff });
    if (!force && now === lastState) return;
    lastState = now;
    document.dispatchEvent(new CustomEvent('meet-pip-state', { detail: now, bubbles: true }));
  }

  // Left of the whole control cluster; the mic button has a chevron beside it.
  function positionDock() {
    const mic = MEET.micButton();
    if (!mic) return;
    const r = mic.getBoundingClientRect();
    if (!r.width) return;
    let edge = r.left;
    for (let el = mic.parentElement, i = 0; el && i < 8; el = el.parentElement, i++) {
      const b = el.getBoundingClientRect();
      if (b.height > r.height * 2.5) break;        // left the bar's row
      edge = Math.min(edge, b.left);
      if (b.width > 280) break;                    // that is the cluster
    }
    const size = Math.max(36, Math.min(56, Math.round(r.height)));
    const left = Math.max(12, Math.round(edge - size - 16));
    dock.style.width = dock.style.height = size + 'px';
    dock.style.left = left + 'px';
    dock.style.top = Math.round(r.top + (r.height - size) / 2) + 'px';
  }
  window.addEventListener('resize', positionDock);

  // Main loops
  // Full rate only while the composite can be seen: PiP opened by the
  // button, or the Meet page not focused. Firefox does not tell pages
  // about PiP opened by its own toggle or shortcut.
  let pipActive = false;
  function setPipActive(on) { pipActive = on; dock.classList.toggle('meet-pip-on', on); }
  // early.js swallows these events in Firefox and reports them here instead.
  if (window.__meetPipEarly) window.__meetPipEarly.onPip = setPipActive;
  mirror.addEventListener('enterpictureinpicture', () => setPipActive(true));
  mirror.addEventListener('leavepictureinpicture', () => setPipActive(false));
  function targetFps() {
    if (!state.inCall) return 1;
    return pipActive || hand.since || !document.hasFocus() ? CONFIG.fps : CONFIG.idleFps;
  }
  let lastDraw = 0;
  function tick(now) {
    if (now - lastDraw >= 1000 / targetFps() - 1) {
      lastDraw = now;
      try { compose(); } catch (e) { log('compose error', e); }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  // rAF is throttled in a hidden tab without PiP; keep the frame from going stale.
  setInterval(() => {
    if (performance.now() - lastDraw > 900) { lastDraw = performance.now(); try { compose(); } catch (e) { /* ignore */ } }
  }, 1000);

  function sync() {
    const inCall = MEET.inCall();
    if (inCall !== state.inCall) {
      state.inCall = inCall;
      root.classList.toggle('meet-pip-hidden', !inCall);
      if (inCall) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      else { observer.disconnect(); speakObserver.disconnect(); watchedTiles = new WeakSet(); speaker.tile = null; chat.length = 0; reactions.length = 0; }
      log(inCall ? 'call started' : 'call ended');
    }
    if (!inCall) return;

    state.micOff = MEET.isOff(MEET.micButton());
    state.camOff = MEET.isOff(MEET.camButton());
    state.handUp = handRaised();
    sendState(false);
    scanChat();
    positionDock();

    // Mirror Meet's mic state so the PiP mute icon is right. The volumechange
    // handler compares against Meet, so this cannot loop.
    if (CONFIG.pipMuteTogglesMic && performance.now() > holdMuteSyncUntil && mirror.muted !== state.micOff) {
      mirror.muted = state.micOff;
    }

    if (mirror.paused && !resuming) mirror.play().catch(() => {});
    // Firefox picks the first playing <video> in document order.
    if (!root.isConnected || document.body.firstElementChild !== root) document.body.prepend(root);

    refreshSources();
  }

  root.classList.add('meet-pip-hidden');
  document.body.prepend(root);
  sync();
  setInterval(sync, CONFIG.syncIntervalMs);
  log('loaded');
})();
