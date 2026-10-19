/** One application-level retry deadline, shared by the retry loop and its UI. */
export class ReconnectLoop {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #disconnected = false;
  #delay = 5_000;

  constructor(
    private readonly attempt: () => void,
    private readonly changed: (nextAttemptAt: number | null) => void,
    private readonly now: () => number = Date.now,
  ) {}

  setDisconnected(disconnected: boolean): void {
    if (this.#disconnected === disconnected) return;
    this.#disconnected = disconnected;
    if (disconnected) this.#schedule();
    else this.stop();
  }

  retryNow(): void {
    if (!this.#disconnected) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    // A synchronous successful attempt may stop the loop.
    try {
      this.attempt();
    } finally {
      if (this.#disconnected) this.#schedule();
    }
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#disconnected = false;
    this.#delay = 5_000;
    this.changed(null);
  }

  #schedule(): void {
    const delay = this.#delay;
    this.#delay = Math.min(delay * 2, 60_000);
    this.#timer = setTimeout(() => this.retryNow(), delay);
    this.changed(this.now() + delay);
  }
}

export function reconnectMessage(nextAttemptAt: number | null, now: number): string {
  const seconds = Math.max(0, Math.ceil(((nextAttemptAt ?? now) - now) / 1_000));
  if (seconds === 0) return "Offline — reconnecting…";
  const minutes = Math.ceil(seconds / 60);
  const wait = seconds >= 60
    ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
    : `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  return `Offline — trying to reconnect in ${wait}.`;
}
