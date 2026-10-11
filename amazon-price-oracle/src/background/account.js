/**
 * Google account for PriceOracle alerts (needs chrome.*).
 *
 * Sign-in: Google OpenID Connect (implicit flow, chrome.identity.launchWebAuthFlow) gives a Google ID
 * token, which Firebase Auth (project xylm-306e6) exchanges for a Firebase ID token + refresh token via
 * the Identity Toolkit REST API. No SDK, no remote code. The session lives in chrome.storage.local and its
 * tokens are only ever sent to Google/Firebase and to the website's API.
 */
import {
  FIREBASE_API_KEY,
  GOOGLE_OAUTH_CLIENT_ID,
  IDENTITY_TOOLKIT_URL,
  SECURE_TOKEN_URL,
  STORAGE_KEYS,
  TOKEN_REFRESH_MARGIN_MS
} from '../shared/constants.js';
import {
  buildGoogleAuthUrl,
  canRefresh,
  firebaseErrorMessage,
  isTokenFresh,
  parseGoogleRedirect,
  refreshSession,
  sessionFromSignIn
} from './alerts-api.js';

export class SignedOutError extends Error {
  constructor(message = 'Your Google sign-in expired. Sign in again.') {
    super(message);
    this.code = 'signed_out';
  }
}

const randomToken = () => crypto.randomUUID().replace(/-/g, '');

async function readSession() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.ACCOUNT_SESSION);
  return stored[STORAGE_KEYS.ACCOUNT_SESSION] || null;
}

const writeSession = (session) => chrome.storage.local.set({ [STORAGE_KEYS.ACCOUNT_SESSION]: session });

/**
 * Token-free note that open product pages watch, so they re-check alerts when the user signs in or out
 * (and are not woken by the hourly token refresh).
 */
const writeMarker = (marker) => chrome.storage.local.set({ [STORAGE_KEYS.ACCOUNT_MARKER]: { ...marker, at: Date.now() } });

/** The refresh token was rejected: forget the tokens but remember who was signed in, so the UI can say "expired". */
async function expireSession(session) {
  await writeSession({ email: session?.email || '', expired: true });
  await writeMarker({ signedIn: false });
}

async function firebasePost(url, init, failure) {
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error('Could not reach Google. Check your connection and try again.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${failure}: ${firebaseErrorMessage(body, `HTTP ${response.status}`)}`);
  return body;
}

/** Account snapshot for Settings, the popup and the card. Never exposes tokens. */
export async function getAccountStatus() {
  const session = await readSession();
  const signedIn = Boolean(session?.refreshToken);
  return {
    signedIn,
    expired: Boolean(session?.expired),
    email: session?.email || '',
    name: session?.name || ''
  };
}

/** Open Google's account chooser, then sign in to Firebase with the result. */
export async function signIn() {
  const redirectUri = chrome.identity.getRedirectURL();
  const state = randomToken();
  const nonce = randomToken();
  const previous = await readSession();
  const finalUrl = await chrome.identity.launchWebAuthFlow({
    url: buildGoogleAuthUrl({ clientId: GOOGLE_OAUTH_CLIENT_ID, redirectUri, state, nonce, loginHint: previous?.email }),
    interactive: true
  });
  const googleIdToken = parseGoogleRedirect(finalUrl, { state, nonce, clientId: GOOGLE_OAUTH_CLIENT_ID });

  const body = await firebasePost(
    `${IDENTITY_TOOLKIT_URL}?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
        requestUri: 'http://localhost',
        returnSecureToken: true,
        returnIdpCredential: true
      })
    },
    'Firebase sign-in failed'
  );
  const session = sessionFromSignIn(body);
  await writeSession(session);
  await writeMarker({ signedIn: true, email: session.email });
  return getAccountStatus();
}

export async function signOut() {
  await chrome.storage.local.remove(STORAGE_KEYS.ACCOUNT_SESSION);
  await writeMarker({ signedIn: false });
  return getAccountStatus();
}

/** The website rejected even a freshly refreshed token: treat the session as expired. */
export async function invalidateSession() {
  await expireSession(await readSession());
}

let refreshing = null;

async function refresh(session) {
  if (!canRefresh(session)) throw new SignedOutError();
  if (!refreshing) {
    refreshing = firebasePost(
      `${SECURE_TOKEN_URL}?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken })
      },
      'Token refresh failed'
    )
      .then(async (body) => {
        const next = refreshSession(session, body);
        await writeSession(next);
        return next;
      })
      .catch(async (err) => {
        // Only a rejected refresh token ends the session; a network blip must not sign the user out.
        if (/INVALID_REFRESH_TOKEN|TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND/.test(err.message)) {
          await expireSession(session);
          throw new SignedOutError();
        }
        throw err;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/**
 * A valid Firebase ID token for the Authorization header. Tokens last about an hour, so this refreshes
 * shortly before expiry (or immediately with `force`, e.g. after a 401) rather than trusting a cached one.
 * @returns {Promise<{idToken: string, email: string}>}
 */
export async function getIdToken({ force = false } = {}) {
  const session = await readSession();
  if (!session?.refreshToken) throw new SignedOutError(session?.expired ? undefined : 'Sign in with Google first.');
  if (!force && isTokenFresh(session, TOKEN_REFRESH_MARGIN_MS)) return { idToken: session.idToken, email: session.email };
  const next = await refresh(session);
  return { idToken: next.idToken, email: next.email };
}
