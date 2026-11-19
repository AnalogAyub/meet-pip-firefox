// Runs in the main process. Rebroadcasts a Meet tab's mic/camera state so the
// PiP window showing that tab can pick it up.
export class MeetPipBridgeParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    if (name !== "MeetPip:State") return;
    Services.obs.notifyObservers(null, "meet-pip-state", JSON.stringify({
      browserId: this.browsingContext?.top.browserId,
      state: data,
    }));
  }
}
