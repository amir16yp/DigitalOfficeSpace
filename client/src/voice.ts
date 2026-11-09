import type { IceServer } from "./types";

type SignalData = {
  kind: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
};

type Peer = {
  pc: RTCPeerConnection;
  gain: GainNode;
  panner: StereoPannerNode;
  pending: RTCIceCandidateInit[];
};

export class Voice {
  ice: IceServer[] = [];
  myId = "";
  radius = 4;
  onSignal: (to: string, data: SignalData) => void = () => {};
  private peers = new Map<string, Peer>();
  private earlyIce = new Map<string, RTCIceCandidateInit[]>();
  private local: MediaStream | null = null;
  private ctx: AudioContext | null = null;

  private started = false;

  async start() {
    if (this.started) return;
    this.started = true;
    this.ctx = new AudioContext();
    await this.ctx.resume();
    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    } catch {
      this.local = null;
    }
  }

  setMuted(muted: boolean) {
    this.local?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  close() {
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.local?.getTracks().forEach((track) => track.stop());
    this.local = null;
    void this.ctx?.close();
    this.ctx = null;
    this.earlyIce.clear();
    this.started = false;
  }

  sync(ids: string[]) {
    const want = new Set(ids);
    for (const id of [...this.peers.keys()]) {
      if (!want.has(id)) this.drop(id);
    }
    for (const id of ids) {
      if (!this.peers.has(id)) this.add(id);
    }
  }

  update(me: { x: number; y: number } | undefined, players: Map<string, { x: number; y: number }>, audible: Set<string>) {
    if (!me || !this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [id, peer] of this.peers) {
      const other = players.get(id);
      let gain = 0;
      let pan = 0;
      if (other && audible.has(id)) {
        const dx = other.x - me.x;
        const dy = other.y - me.y;
        const dist = Math.hypot(dx, dy);
        const t = Math.min(1, dist / this.radius);
        gain = (1 - t) * (1 - t);
        pan = Math.max(-1, Math.min(1, dx / this.radius));
      }
      peer.gain.gain.setTargetAtTime(gain, now, 0.06);
      peer.panner.pan.setTargetAtTime(pan, now, 0.06);
    }
  }

  async handle(from: string, data: SignalData) {
    if (data.kind === "offer" && this.myId < from) return;
    if (!this.peers.has(from)) {
      if (data.kind === "ice") {
        const queued = this.earlyIce.get(from) ?? [];
        if (data.candidate) queued.push(data.candidate);
        this.earlyIce.set(from, queued);
        return;
      }
      this.add(from);
    }
    const peer = this.peers.get(from);
    if (!peer) return;
    if (data.kind === "offer" && data.sdp) {
      await peer.pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.onSignal(from, { kind: "answer", sdp: answer.sdp });
      await this.flush(peer);
    } else if (data.kind === "answer" && data.sdp) {
      await peer.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      await this.flush(peer);
    } else if (data.kind === "ice" && data.candidate) {
      if (!peer.pc.remoteDescription) peer.pending.push(data.candidate);
      else await peer.pc.addIceCandidate(data.candidate);
    }
  }

  private add(id: string) {
    if (!this.ctx) return;
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    gain.gain.value = 0;
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    const peer: Peer = { pc, gain, panner, pending: [] };
    this.peers.set(id, peer);
    const early = this.earlyIce.get(id);
    if (early) {
      peer.pending.push(...early);
      this.earlyIce.delete(id);
    }
    if (this.local) {
      for (const track of this.local.getAudioTracks()) pc.addTrack(track, this.local);
    } else {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }
    pc.onicecandidate = (event) => {
      if (event.candidate) this.onSignal(id, { kind: "ice", candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.ctx?.createMediaStreamSource(stream).connect(gain);
    };
    if (this.myId < id) void this.offer(id);
  }

  private async offer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.onSignal(id, { kind: "offer", sdp: offer.sdp });
  }

  private async flush(peer: Peer) {
    const pending = peer.pending.splice(0);
    for (const candidate of pending) {
      await peer.pc.addIceCandidate(candidate);
    }
  }

  private drop(id: string) {
    const peer = this.peers.get(id);
    peer?.pc.close();
    this.peers.delete(id);
  }
}

export const voice = new Voice();
