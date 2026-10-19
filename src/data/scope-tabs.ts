/** Control messages only; RxDB broadcasts document changes through its own channel. */
export class ScopeTabs<Snapshot> {
  readonly #channel: BroadcastChannel | null;
  readonly #waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  #closed = false;
  #sequence = 0;
  readonly #id = crypto.randomUUID();
  readonly #peers = new Set<string>();
  #resetAcknowledgements = new Set<string>();
  #remoteReset: Promise<void> = Promise.resolve();
  readonly #presencePrefix: string;
  readonly #presenceReady: Promise<void>;
  #releasePresence: (() => void) | undefined;
  constructor(name: string, private readonly options: {
    isLeader: () => boolean;
    snapshot: () => Snapshot;
    receive: (snapshot: Snapshot) => void;
    sync: () => Promise<void>;
    pauseForReset: () => Promise<void>;
    resumeAfterReset: () => Promise<void>;
    sent: () => void;
  }) {
    this.#presencePrefix = `rational-sync:presence:${name}:`;
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    this.#presenceReady = locks ? new Promise<void>((ready, reject) => {
      void locks.request(`${this.#presencePrefix}${this.#id}`, async () => {
        ready();
        await new Promise<void>(release => { this.#releasePresence = release; if (this.#closed) release(); });
      }).catch(reject);
    }) : Promise.resolve();
    this.#channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`rational-sync:${name}`);
    if (this.#channel) this.#channel.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (typeof message?.sender !== "string") return;
      if (message.kind === "leave") { this.#peers.delete(message.sender); return; }
      this.#peers.add(message.sender);
      if (message.kind === "reset-start") {
        this.#remoteReset = this.#remoteReset.then(() => options.pauseForReset());
        void this.#remoteReset.then(() => this.#post({ kind: "reset-ack", target: message.sender }));
      }
      if (message.kind === "reset-ack" && message.target === this.#id) this.#resetAcknowledgements.add(message.sender);
      if (message.kind === "reset-end") {
        void this.#remoteReset.then(() => options.resumeAfterReset());
      }
      if (message?.kind === "hello" && options.isLeader()) this.publish();
      if (message?.kind === "status" && !options.isLeader()) options.receive(message.snapshot as Snapshot);
      if (message?.kind === "sync" && options.isLeader()) {
        void options.sync().then(() => {
          this.publish();
          this.#post({ kind: "synced", request: message.request });
        }).catch(() => { /* The follower retries with the next available leader. */ });
      }
      if (message?.kind === "synced") this.#waiting.get(message.request)?.resolve();
      if (message.kind === "sent") options.sent();
    };
    this.#post({ kind: "hello" });
  }
  publish(): void {
    if (this.options.isLeader()) this.#post({ kind: "status", snapshot: this.options.snapshot() });
  }
  requestStatus(): void { this.#post({ kind: "hello" }); }
  async pausePeers(): Promise<void> {
    await this.#presenceReady;
    this.#resetAcknowledgements.clear();
    this.#post({ kind: "reset-start" });
    const deadline = Date.now() + 10_000;
    while (await this.#hasUnpausedPeers()) {
      if (Date.now() > deadline) {
        this.resumePeers();
        throw new Error("Another tab could not pause synchronization. Close it before resetting local data.");
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  async #hasUnpausedPeers(): Promise<boolean> {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    // The browser releases presence locks even when a tab crashes or closes
    // without sending "leave". A stale peer must not block sign-out/reset.
    const live = locks ? new Set((await locks.query()).held?.map(lock => lock.name)) : null;
    return [...this.#peers].some(peer => !this.#resetAcknowledgements.has(peer)
      && (live === null || live.has(`${this.#presencePrefix}${peer}`)));
  }
  resumePeers(): void { this.#post({ kind: "reset-end" }); }
  sent(): void { this.#post({ kind: "sent" }); }
  async sync(): Promise<void> {
    if (this.options.isLeader() || !this.#channel) return this.options.sync();
    const request = `${this.#id}:${++this.#sequence}`;
    const send = () => {
      if (this.options.isLeader()) {
        void this.options.sync().then(() => this.#waiting.get(request)?.resolve()).catch(() => {});
      } else this.#post({ kind: "sync", request });
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.#waiting.set(request, { resolve, reject });
        send();
        timer = setInterval(send, 1000);
      });
    } finally {
      clearInterval(timer);
      this.#waiting.delete(request);
    }
  }
  close(): void {
    this.#post({ kind: "leave" });
    this.#closed = true;
    this.#releasePresence?.();
    this.#channel?.close();
    for (const waiting of this.#waiting.values()) waiting.reject(new Error("Sync scope closed"));
    this.#waiting.clear();
  }
  #post(message: object): void { if (!this.#closed) this.#channel?.postMessage({ ...message, sender: this.#id }); }
}
