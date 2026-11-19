// Loaded by Sine into Firefox's Picture-in-Picture player window. When the
// window shows a Google Meet tab, replaces the player's play/mute controls
// with a bar of real buttons: mic, camera, quick reactions, a chat box and
// end call. The Meet PiP for Firefox extension, running in the tab, carries
// out the commands.
(() => {
  "use strict";
  if (window.__meetPipMod) return;
  window.__meetPipMod = true;

  const REACTIONS = ["💖", "👍", "🎉", "👏", "😂", "😮"];
  const { PictureInPicture } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs"
  );

  // This mod's folder under chrome/sine-mods, served as chrome://sine/content/.
  const folder = (Components.stack.filename || "").match(/chrome:\/\/sine\/content\/(.+)\/[^/]+$/)?.[1] || "meet-pip";

  // Runs in the Meet tab's process. Hands commands to the extension's content
  // script as DOM events and passes its state events back. Loaded again for
  // every PiP window, so it sets itself up only once per tab.
  const FRAME_SCRIPT = "data:application/javascript;charset=utf-8," + encodeURIComponent(`
    if (!globalThis.meetPipBridge) {
      globalThis.meetPipBridge = true;
      addMessageListener("MeetPip:Command", m => {
        content.document.dispatchEvent(new content.CustomEvent("meet-pip-command", { detail: JSON.stringify(m.data) }));
      });
      addEventListener("meet-pip-state", e => {
        if (typeof e.detail === "string") sendAsyncMessage("MeetPip:State", e.detail.slice(0, 200));
      }, true, true);
    }
  `);

  // Opens the macOS "Emoji & Symbols" picker, the one Ctrl+Cmd+Space opens.
  // Firefox has no script API for it, so this sends AppKit the same message
  // the Edit menu item does: [NSApp orderFrontCharacterPalette:nil].
  function showSystemEmojiPicker() {
    if (Services.appinfo.OS !== "Darwin") return;
    let objc;
    try {
      const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      objc = ctypes.open("/usr/lib/libobjc.A.dylib");
      const ptr = ctypes.voidptr_t;
      const getClass = objc.declare("objc_getClass", ctypes.default_abi, ptr, ctypes.char.ptr);
      const selector = objc.declare("sel_registerName", ctypes.default_abi, ptr, ctypes.char.ptr);
      const call = objc.declare("objc_msgSend", ctypes.default_abi, ptr, ptr, ptr);
      const callWithArg = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.void_t, ptr, ptr, ptr);
      const app = call(getClass("NSApplication"), selector("sharedApplication"));
      callWithArg(app, selector("orderFrontCharacterPalette:"), null);
    } catch (e) {
      console.warn("[meet-pip] could not open the macOS emoji picker; type or paste an emoji instead", e);
    } finally {
      try { objc?.close(); } catch (e) { /* ignore */ }
    }
  }

  // Material mic, mic_off, videocam, videocam_off, call_end.
  const ICONS = {
    micOn: "M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z",
    micOff: "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z",
    camOn: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z",
    camOff: "M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z",
    end: "M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z",
  };

  function start(browser) {
    const mm = browser.messageManager;
    try {
      // Third argument: run in the tab's shared scope, so the once-only check works.
      mm.loadFrameScript(FRAME_SCRIPT, false, true);
      mm.addMessageListener("MeetPip:State", onState);
    } catch (e) {
      console.error("[meet-pip] could not reach the Meet tab", e);
    }
    // Each command carries an id; the extension ignores one it has seen.
    let nextId = 0;
    const session = Date.now().toString(36);
    const send = cmd => {
      try {
        mm.sendAsyncMessage("MeetPip:Command", { ...cmd, id: `${session}-${nextId++}` });
      } catch (e) {
        console.error("[meet-pip] could not reach the Meet tab", e);
      }
    };

    const el = (tag, attrs = {}, ...children) => {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      node.append(...children);
      return node;
    };
    const icon = name => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", ICONS[name]);
      svg.append(path);
      return svg;
    };
    const button = (attrs, child, onClick) => {
      const b = el("button", { type: "button", ...attrs }, child);
      b.addEventListener("click", onClick);
      return b;
    };

    const mic = button({ title: "Microphone" }, icon("micOn"), () => send({ cmd: "mic" }));
    // Firefox applies a saved camera permission only when it could show the
    // permission prompt: the Meet tab selected and its window the active one.
    // While you are in the PiP window neither holds, so the request waits. To
    // turn the camera on: wait for Meet's request to exist, bring the Meet tab
    // and its window forward, and go back the moment the request is gone
    // (granted). Turning the camera off needs none of this.
    let camOn = null;
    const cam = button({ title: "Camera" }, icon("camOn"), () => {
      send({ cmd: "cam" });
      if (camOn === true) return;
      const log = (...a) => console.log("[meet-pip] camera:", ...a);
      // The window holding the tab: documentGlobal in current Firefox, ownerGlobal before.
      const win = browser.documentGlobal || browser.ownerGlobal;
      const tabs = win?.gBrowser;
      const meetTab = tabs?.getTabForBrowser(browser);
      if (!meetTab) { log("could not find the Meet tab"); return; }
      const previous = tabs.selectedTab;
      const request = () => {
        try { return win.PopupNotifications.getNotification("webRTC-shareDevices", browser); } catch (e) { return null; }
      };
      const clicked = Date.now();
      let forwardAt = 0, sawRequest = false;
      const step = () => {
        const pending = !!request();
        sawRequest ||= pending;
        if (!forwardAt) {
          // Go forward once Meet has asked, or after 600ms in case the request can't be seen.
          if (pending || Date.now() - clicked > 600) {
            if (tabs.selectedTab !== meetTab) tabs.selectedTab = meetTab;
            win.focus();
            forwardAt = Date.now();
          }
        } else if (sawRequest ? !pending : Date.now() - forwardAt > 1500) {
          if (previous !== meetTab && previous.isConnected) tabs.selectedTab = previous;
          if (!window.closed) window.focus();
          log(`granted; Meet tab was in front for ${Date.now() - forwardAt}ms`);
          return;
        } else if (Date.now() - forwardAt > 4000) {
          // Still asking: Firefox is showing its prompt, so stay on the Meet tab to answer it.
          log("Firefox is asking for camera permission; staying on the Meet tab");
          return;
        }
        win.setTimeout(step, 30);
      };
      win.setTimeout(step, 30);
    });
    const chat = el("input", { type: "text", placeholder: "Message everyone", maxlength: "500" });
    const end = button({ class: "end", title: "Leave call and close the tab" }, icon("end"), () => {
      send({ cmd: "leave" });
      // Give Meet a moment to hang up, then close its tab. The PiP window goes with it.
      setTimeout(() => {
        const gBrowser = (browser.documentGlobal || browser.ownerGlobal)?.gBrowser || browser.getTabBrowser?.();
        const tab = gBrowser?.getTabForBrowser(browser);
        if (tab) gBrowser.removeTab(tab);
      }, 700);
    });
    // Any other emoji: "+" opens the macOS emoji picker, which types into a hidden box.
    // Invisible: it only exists to receive what the macOS picker types.
    const custom = el("input", { type: "text", class: "emoji", maxlength: "16", tabindex: "-1", "aria-label": "Another emoji" });
    const more = button({ class: "react", title: "Another emoji" }, "＋", () => {
      // The macOS picker types into whatever has focus, so focus the box first.
      custom.value = "";
      custom.focus();
      showSystemEmojiPicker();
    });
    // Whatever the picker (or a paste) puts in the box is sent straight away.
    custom.addEventListener("input", () => {
      const first = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(custom.value.trim())][0]?.segment;
      if (!first || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first)) return;
      send({ cmd: "react", emoji: first });
      custom.value = "";
    });
    const bar = el("div", { id: "meetpip-bar" },
      el("div", { class: "row reactions" },
        ...REACTIONS.map(emoji => button({ class: "react", title: emoji }, emoji, () => send({ cmd: "react", emoji }))),
        more, custom),
      el("div", { class: "row" }, mic, cam, chat, end));

    // The player treats key presses as playback shortcuts (space would switch
    // the camera off), so keep typing to the text boxes.
    const onEnter = (input, submit) => {
      for (const type of ["keydown", "keyup", "keypress"]) {
        input.addEventListener(type, e => {
          e.stopPropagation();
          if (type !== "keydown") return;
          if (e.key === "Enter" && input.value.trim()) {
            submit(input.value.trim());
            input.value = "";
          } else if (e.key === "Escape") {
            input.blur();
          }
        });
      }
    };
    onEnter(chat, text => send({ cmd: "chat", text }));
    onEnter(custom, text => {
      // First emoji only, whole (flags and skin tones are several code points).
      const first = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)][0]?.segment;
      if (first) send({ cmd: "react", emoji: first });
    });

    const setIcon = (btn, name, off) => {
      btn.replaceChildren(icon(name));
      btn.toggleAttribute("off", off);
    };
    const showState = json => {
      let state;
      try { state = JSON.parse(json); } catch (e) { return; }
      setIcon(mic, state.mic ? "micOn" : "micOff", !state.mic);
      setIcon(cam, state.cam ? "camOn" : "camOff", !state.cam);
      camOn = !!state.cam;
    };
    function onState(m) { showState(m.data); }
    window.addEventListener("unload", () => {
      try { mm.removeMessageListener("MeetPip:State", onState); } catch (e) { /* tab gone */ }
    }, { once: true });

    // The query keeps Firefox from reusing a cached copy after the mod is updated.
    document.head.append(el("link", { rel: "stylesheet", href: `chrome://sine/content/${folder}/player.css?${Date.now()}` }));
    document.documentElement.setAttribute("meetpip", "");
    document.body.append(bar);
    send({ cmd: "hello" });
  }

  // The player learns which tab it belongs to shortly after it loads.
  let tries = 0;
  const timer = setInterval(() => {
    const browser = PictureInPicture.weakWinToBrowser.get(window);
    if (!browser && ++tries < 50) return;
    clearInterval(timer);
    let host = "";
    try { host = browser?.currentURI.host; } catch (e) { /* no host */ }
    if (host === "meet.google.com") start(browser);
  }, 100);
})();
