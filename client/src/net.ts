type Handler = (message: Record<string, unknown>) => void;

export class Net {
  onMessage: Handler = () => {};
  onOpen: () => void = () => {};
  onStatus: (status: string) => void = () => {};
  private socket: WebSocket | null = null;
  private retry = 400;
  private timer = 0;
  private giveUp = false;

  connect() {
    this.giveUp = false;
    window.clearTimeout(this.timer);
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    this.socket = socket;
    this.onStatus("connecting");
    socket.onopen = () => {
      this.retry = 400;
      this.onStatus("connected");
      this.onOpen();
    };
    socket.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      this.onStatus("reconnecting");
      if (!this.giveUp) {
        this.timer = window.setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(4000, this.retry * 2);
      }
    };
  }

  send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  stop() {
    this.giveUp = true;
    window.clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
    this.onStatus("offline");
  }
}

export const net = new Net();
