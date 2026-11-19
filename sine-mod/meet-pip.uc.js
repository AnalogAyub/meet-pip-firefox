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
  const ACTOR = "MeetPipBridge";
  const { PictureInPicture } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs"
  );

  // The bridge actor's modules are loaded by URL from the tab's process, so
  // this mod's folder needs a resource:// name.
  function registerActor() {
    const folder = (Components.stack.filename || "").match(/chrome:\/\/sine\/content\/(.+)\/[^/]+$/)?.[1] || "meet-pip";
    const dir = Services.dirsvc.get("ProfD", Ci.nsIFile);
    for (const part of ["chrome", "sine-mods", ...folder.split("/")]) dir.append(part);
    const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
    if (!res.hasSubstitution("meet-pip-mod")) res.setSubstitution("meet-pip-mod", Services.io.newFileURI(dir));
    try {
      ChromeUtils.registerWindowActor(ACTOR, {
        parent: { esModuleURI: "resource://meet-pip-mod/bridge-parent.js" },
        child: { esModuleURI: "resource://meet-pip-mod/bridge-child.js" },
        matches: ["https://meet.google.com/*"],
        allFrames: false,
      });
    } catch (e) {
      // Already registered by an earlier PiP window.
      if (e.name !== "NotSupportedError") console.error("[meet-pip] actor registration failed", e);
    }
  }

  const STYLE = `
    :root[meetpip] #controls-bottom,
    :root[meetpip] #controls-bottom-gradient { display: none !important; }
    #meetpip-bar {
      position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
      display: flex; flex-direction: column; gap: 6px; padding: 18px 8px 8px;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.78) 45%);
      opacity: 0; transition: opacity 160ms linear;
      -moz-window-dragging: no-drag;
      font: 13px system-ui, sans-serif; color: #e8eaed;
    }
    body:hover #meetpip-bar, #meetpip-bar:focus-within { opacity: 1; }
    #meetpip-bar .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
    #meetpip-bar .reactions { justify-content: center; }
    #meetpip-bar button {
      appearance: none; border: 0; flex: none; width: 30px; height: 30px; padding: 0;
      border-radius: 50%; background: #3c4043; color: #e8eaed; cursor: pointer;
      display: grid; place-items: center; font-size: 16px; line-height: 1;
    }
    #meetpip-bar button:hover { background: #5f6368; }
    #meetpip-bar button[off] { background: #f9dedc; color: #8c1d18; }
    #meetpip-bar button.react { background: transparent; font-size: 18px; }
    #meetpip-bar button.react:hover { background: rgba(255, 255, 255, 0.2); }
    #meetpip-bar button.end { background: #d93025; color: #fff; width: 40px; border-radius: 15px; }
    #meetpip-bar button.end:hover { background: #ea4335; }
    #meetpip-bar svg { width: 18px; height: 18px; fill: currentColor; }
    #meetpip-bar input {
      flex: 1; min-width: 0; height: 30px; box-sizing: border-box; padding: 0 12px;
      border: 0; border-radius: 15px; background: rgba(60, 64, 67, 0.95); color: #e8eaed; font: inherit;
    }
    #meetpip-bar input::placeholder { color: #9aa0a6; }
  `;
  // Material mic, mic_off, videocam, videocam_off, call_end.
  const ICONS = {
    micOn: "M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z",
    micOff: "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z",
    camOn: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z",
    camOff: "M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z",
    end: "M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z",
  };

  function start(browser) {
    registerActor();
    const send = cmd => {
      try {
        browser.browsingContext.currentWindowGlobal.getActor(ACTOR).sendAsyncMessage("MeetPip:Command", cmd);
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
    const cam = button({ title: "Camera" }, icon("camOn"), () => send({ cmd: "cam" }));
    const chat = el("input", { type: "text", placeholder: "Message everyone", maxlength: "500" });
    const end = button({ class: "end", title: "Leave call and close the tab" }, icon("end"), () => {
      send({ cmd: "leave" });
      // Give Meet a moment to hang up, then close its tab. The PiP window goes with it.
      setTimeout(() => {
        const gBrowser = browser.getTabBrowser?.();
        const tab = gBrowser?.getTabForBrowser(browser);
        if (tab) gBrowser.removeTab(tab);
      }, 700);
    });
    const bar = el("div", { id: "meetpip-bar" },
      el("div", { class: "row reactions" },
        ...REACTIONS.map(emoji => button({ class: "react", title: emoji }, emoji, () => send({ cmd: "react", emoji })))),
      el("div", { class: "row" }, mic, cam, chat, end));

    // The player treats key presses as playback shortcuts (space would switch
    // the camera off), so keep typing to the chat box.
    for (const type of ["keydown", "keyup", "keypress"]) {
      chat.addEventListener(type, e => {
        e.stopPropagation();
        if (type !== "keydown") return;
        if (e.key === "Enter" && chat.value.trim()) {
          send({ cmd: "chat", text: chat.value });
          chat.value = "";
        } else if (e.key === "Escape") {
          chat.blur();
        }
      });
    }

    const setIcon = (btn, name, off) => {
      btn.replaceChildren(icon(name));
      btn.toggleAttribute("off", off);
    };
    const observer = {
      observe(_subject, _topic, data) {
        let msg, state;
        try { msg = JSON.parse(data); state = JSON.parse(msg.state); } catch (e) { return; }
        if (msg.browserId !== browser.browserId) return;
        setIcon(mic, state.mic ? "micOn" : "micOff", !state.mic);
        setIcon(cam, state.cam ? "camOn" : "camOff", !state.cam);
      },
    };
    Services.obs.addObserver(observer, "meet-pip-state");
    window.addEventListener("unload", () => Services.obs.removeObserver(observer, "meet-pip-state"), { once: true });

    document.head.append(el("style", {}, STYLE));
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
