// Runs in the Meet tab's process. Hands commands to the extension's content
// script as DOM events and passes its state events back.
export class MeetPipBridgeChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    const win = this.contentWindow;
    if (name !== "MeetPip:Command" || !win) return;
    if (!this.listening) {
      this.listening = true;
      // Fourth argument: accept events dispatched by content.
      win.document.addEventListener("meet-pip-state", e => {
        if (typeof e.detail === "string") this.sendAsyncMessage("MeetPip:State", e.detail.slice(0, 200));
      }, false, true);
    }
    win.document.dispatchEvent(new win.CustomEvent("meet-pip-command", { detail: JSON.stringify(data) }));
  }
}
