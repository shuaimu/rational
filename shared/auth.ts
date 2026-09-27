import {
  BrowserAuthSessionPersistence,
  MakoAuthClient,
  MakoAuthenticationRequiredError,
  type AuthSessionPersistence,
  type NormalizedMakoRxdbClientConfig,
  type MakoUserSession,
} from '@mako-cloud/rxdb';

// Retain Rational's existing persistence key so installed sessions survive the
// addition of Investment. Project and environment identifiers scope credentials.
export function sessionKey(config: { projectId: string; environmentId: string }): string {
  return `rational.auth.${config.projectId}.${config.environmentId}`;
}
export function sessionPersistence(config: NormalizedMakoRxdbClientConfig): AuthSessionPersistence {
  return new BrowserAuthSessionPersistence(config, { key: sessionKey(config) });
}

export class SharedAuthClient extends MakoAuthClient {
  private adoptedUser: string | null = null;
  private renewal: Promise<MakoUserSession> | undefined;
  private readonly lockKey: string;
  private readonly durable: boolean;

  constructor(config: NormalizedMakoRxdbClientConfig, options: {
    persistence?: AuthSessionPersistence;
    fetch?: typeof globalThis.fetch;
  } = {}) {
    const persistence = options.persistence ?? sessionPersistence(config);
    super(config, { ...options, persistence });
    this.lockKey = `${sessionKey(config)}.renew`;
    this.durable = persistence instanceof BrowserAuthSessionPersistence && persistence.durable;
    this.subscribe(event => {
      if (event.kind === 'session' || event.kind === 'signed_out') this.adoptedUser = event.session?.user.id ?? null;
    });
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    return await (locks && this.durable ? locks.request(this.lockKey, action) : action());
  }

  override async restoreSession(): Promise<MakoUserSession | null> {
    const session = await super.restoreSession();
    this.adoptedUser = session?.user.id ?? null;
    return session;
  }

  override refreshSession(): Promise<MakoUserSession> {
    if (this.renewal) return this.renewal;
    const before = this.accessToken();
    this.renewal = this.locked(async () => {
      const session = await super.restoreSession();
      if (session && session.user.id !== this.adoptedUser) throw new MakoAuthenticationRequiredError('Application session changed.', { code: 'session_changed', status: 401 });
      if (!session) throw new MakoAuthenticationRequiredError('Sign in to continue.', { code: 'unauthenticated', status: 401 });
      if (session.accessToken !== before && session.expiresAtUnixMilliseconds > Date.now() + 30_000) return session;
      return super.refreshSession();
    }).finally(() => { this.renewal = undefined; });
    return this.renewal;
  }

  override async validAccessToken(minimumValidityMilliseconds?: number): Promise<string> {
    // A storage event can lag a request. Read the shared session first so a
    // stale tab cannot keep using the previous signed-in user's token.
    const session = await super.restoreSession();
    if (session && session.user.id !== this.adoptedUser) throw new MakoAuthenticationRequiredError('Application session changed.', { code: 'session_changed', status: 401 });
    return super.validAccessToken(minimumValidityMilliseconds);
  }

  override signInWithPassword(email: string, password: string): Promise<MakoUserSession> {
    return this.locked(() => super.signInWithPassword(email, password));
  }

  override completeProviderSignIn(fragment: string): Promise<MakoUserSession> {
    return this.locked(() => super.completeProviderSignIn(fragment));
  }

  override redeemMagicLink(token: string): Promise<MakoUserSession> {
    return this.locked(() => super.redeemMagicLink(token));
  }

  override signOut(): Promise<void> {
    return this.locked(async () => {
      await super.restoreSession();
      await super.signOut();
    });
  }
}
