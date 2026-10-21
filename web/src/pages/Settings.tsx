import { useEffect, useRef, useState } from "react";
import {
  SettingsStatus,
  disconnectPlex,
  disconnectSilo,
  disconnectTmdb,
  disconnectTrakt,
  disconnectXtream,
  fetchSettingsStatus,
  pollPlexLink,
  pollTraktLink,
  saveSilo,
  saveTmdb,
  saveTrakt,
  saveXtream,
  startPlexLink,
  startTraktLink,
  testConnection,
} from "../api.js";
import { APP_VERSION } from "../appVersion.js";

type PlexLinkState =
  | { phase: "idle" }
  | { phase: "waiting"; code: string; pinId: number }
  | { phase: "error"; message: string };

type TraktLinkState =
  | { phase: "idle" }
  | { phase: "waiting"; userCode: string; verificationUrl: string }
  | { phase: "error"; message: string };

const PLEX_LINK_TIMEOUT_MS = 10 * 60 * 1000;
const TRAKT_LINK_TIMEOUT_MS = 10 * 60 * 1000;

function CredentialForm({
  title,
  description,
  onSubmit,
}: {
  title: string;
  description: string;
  onSubmit: (baseUrl: string, username: string, password: string) => Promise<void>;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [allowInsecure, setAllowInsecure] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const insecure = baseUrl.trim().toLowerCase().startsWith("http://");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit(baseUrl, username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={handleSubmit}>
      <p className="settings-desc">{description}</p>
      <label>
        Server URL
        <input
          type="text"
          placeholder="https://your-server.example.com"
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            if (!e.target.value.trim().toLowerCase().startsWith("http://")) setAllowInsecure(false);
          }}
          required
        />
      </label>
      <label>
        Username
        <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {insecure && (
        <label className="settings-insecure">
          <input
            type="checkbox"
            checked={allowInsecure}
            onChange={(e) => setAllowInsecure(e.target.checked)}
            required
          />
          This server is plain HTTP. The password is sent in clear text. Continue only on a network you trust.
        </label>
      )}
      {error && <div className="settings-error">{error}</div>}
      <button type="submit" disabled={saving || (insecure && !allowInsecure)}>
        {saving ? "Connecting…" : `Log in to ${title}`}
      </button>
    </form>
  );
}

function TokenForm({
  description,
  placeholder,
  buttonLabel,
  onSubmit,
}: {
  description: string;
  placeholder: string;
  buttonLabel: string;
  onSubmit: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit(token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={handleSubmit}>
      <p className="settings-desc">{description}</p>
      <label>
        API Read Access Token
        <input type="text" placeholder={placeholder} value={token} onChange={(e) => setToken(e.target.value)} required />
      </label>
      {error && <div className="settings-error">{error}</div>}
      <button type="submit" disabled={saving}>
        {saving ? "Connecting…" : buttonLabel}
      </button>
    </form>
  );
}

function ClientCredentialForm({
  description,
  onSubmit,
}: {
  description: string;
  onSubmit: (clientId: string, clientSecret: string) => Promise<void>;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit(clientId, clientSecret);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={handleSubmit}>
      <p className="settings-desc">{description}</p>
      <label>
        Client ID
        <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} required />
      </label>
      <label>
        Client Secret
        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} required />
      </label>
      {error && <div className="settings-error">{error}</div>}
      <button type="submit" disabled={saving}>
        {saving ? "Checking…" : "Save"}
      </button>
    </form>
  );
}

function TestConnectionButton({ service }: { service: "plex" | "silo" | "xtream" | "tmdb" | "trakt" }) {
  const [state, setState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const resetRef = useRef<number | null>(null);

  async function runTest() {
    setState("testing");
    setMessage(null);
    if (resetRef.current) window.clearTimeout(resetRef.current);
    try {
      await testConnection(service);
      setState("ok");
    } catch (err) {
      setState("error");
      setMessage((err as Error).message);
    }
    resetRef.current = window.setTimeout(() => setState("idle"), 5000);
  }

  return (
    <div className="test-connection">
      <button className="secondary" onClick={runTest} disabled={state === "testing"}>
        {state === "testing" ? "Testing…" : "Test Connection"}
      </button>
      {state === "ok" && <span className="test-connection-ok">Working</span>}
      {state === "error" && <span className="test-connection-error">{message ?? "Failed"}</span>}
    </div>
  );
}

export default function Settings() {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [plexLink, setPlexLink] = useState<PlexLinkState>({ phase: "idle" });
  const [traktLink, setTraktLink] = useState<TraktLinkState>({ phase: "idle" });
  const plexPollRef = useRef<number | null>(null);
  const traktPollRef = useRef<number | null>(null);

  function refreshStatus() {
    fetchSettingsStatus().then(setStatus);
  }

  useEffect(() => {
    refreshStatus();
    return () => {
      if (plexPollRef.current) window.clearInterval(plexPollRef.current);
      if (traktPollRef.current) window.clearInterval(traktPollRef.current);
    };
  }, []);

  async function beginPlexLink() {
    setPlexLink({ phase: "waiting", code: "", pinId: 0 });
    try {
      const { pinId, code } = await startPlexLink();
      setPlexLink({ phase: "waiting", code, pinId });

      // Plex pins expire server-side anyway, but don't poll plex.tv forever if someone
      // starts linking and then walks away without ever finishing the plex.tv/link step.
      const deadline = Date.now() + PLEX_LINK_TIMEOUT_MS;

      plexPollRef.current = window.setInterval(async () => {
        if (Date.now() > deadline) {
          if (plexPollRef.current) window.clearInterval(plexPollRef.current);
          setPlexLink({ phase: "error", message: "Link request timed out. Try again." });
          return;
        }
        try {
          const result = await pollPlexLink(pinId);
          if (result.linked) {
            if (plexPollRef.current) window.clearInterval(plexPollRef.current);
            setPlexLink({ phase: "idle" });
            refreshStatus();
          }
        } catch (err) {
          if (plexPollRef.current) window.clearInterval(plexPollRef.current);
          setPlexLink({ phase: "error", message: (err as Error).message });
        }
      }, 2000);
    } catch (err) {
      setPlexLink({ phase: "error", message: (err as Error).message });
    }
  }

  async function beginTraktLink() {
    setTraktLink({ phase: "waiting", userCode: "", verificationUrl: "" });
    try {
      const { userCode, verificationUrl, interval } = await startTraktLink();
      setTraktLink({ phase: "waiting", userCode, verificationUrl });

      const deadline = Date.now() + TRAKT_LINK_TIMEOUT_MS;

      traktPollRef.current = window.setInterval(async () => {
        if (Date.now() > deadline) {
          if (traktPollRef.current) window.clearInterval(traktPollRef.current);
          setTraktLink({ phase: "error", message: "Link request timed out. Try again." });
          return;
        }
        try {
          const result = await pollTraktLink();
          if (result.linked) {
            if (traktPollRef.current) window.clearInterval(traktPollRef.current);
            setTraktLink({ phase: "idle" });
            refreshStatus();
          }
        } catch (err) {
          if (traktPollRef.current) window.clearInterval(traktPollRef.current);
          setTraktLink({ phase: "error", message: (err as Error).message });
        }
      }, Math.max(interval, 3) * 1000);
    } catch (err) {
      setTraktLink({ phase: "error", message: (err as Error).message });
    }
  }

  if (!status) {
    return <div className="page status">Loading settings…</div>;
  }

  const needsSource = !status.plex && !status.silo && !status.xtream;

  return (
    <div className="page settings-page">
      {needsSource && (
        <div className="notice">
          Start by connecting one source: Plex, Silo, or Xtream Codes. TMDB and Trakt are optional.
        </div>
      )}
      <section className="settings-card settings-card-plex">
        <div className="settings-card-header">
          <h2>Plex</h2>
          {status.plex && <span className="badge connected">Connected{status.plexServerName ? ` · ${status.plexServerName}` : ""}</span>}
        </div>
        {status.plex ? (
          <div className="settings-actions">
            <TestConnectionButton service="plex" />
            <button className="secondary" onClick={() => disconnectPlex().then(refreshStatus)}>
              Disconnect
            </button>
          </div>
        ) : plexLink.phase === "waiting" ? (
          <div className="plex-link">
            {plexLink.code ? (
              <>
                <p>
                  1. Open <a href="https://plex.tv/link" target="_blank" rel="noreferrer">plex.tv/link</a>
                </p>
                <p>
                  2. Enter this code: <strong className="link-code">{plexLink.code}</strong>
                </p>
                <p className="settings-desc">Waiting for you to authorize…</p>
              </>
            ) : (
              <p className="settings-desc">Starting link request…</p>
            )}
          </div>
        ) : (
          <>
            <p className="settings-desc">
              Connect your Plex account — no token to copy, just link it like any other Plex app.
            </p>
            <button onClick={beginPlexLink}>Link Plex Account</button>
          </>
        )}
        {plexLink.phase === "error" && <div className="settings-error">{plexLink.message}</div>}
      </section>

      <section className="settings-card settings-card-silo">
        <div className="settings-card-header">
          <h2>Silo</h2>
          {status.silo && <span className="badge connected">Connected</span>}
        </div>
        {status.silo ? (
          <>
            <p className="settings-desc">
              {status.siloBaseUrl ? `${status.siloBaseUrl} · ` : ""}
              Movies from Silo appear in On Demand. TV shows aren't supported yet.
            </p>
            <div className="settings-actions">
              <TestConnectionButton service="silo" />
              <button className="secondary" onClick={() => disconnectSilo().then(refreshStatus)}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <CredentialForm
            title="Silo"
            description="Log in with your Silo (Jellyfin/Emby-compatible) account."
            onSubmit={async (baseUrl, username, password) => {
              await saveSilo(baseUrl, username, password);
              refreshStatus();
            }}
          />
        )}
      </section>

      <section className="settings-card settings-card-xtream">
        <div className="settings-card-header">
          <h2>Xtream Codes IPTV</h2>
          {status.xtream && <span className="badge connected">Connected</span>}
        </div>
        {status.xtream ? (
          <>
            {status.xtreamBaseUrl && <p className="settings-desc">{status.xtreamBaseUrl}</p>}
            <div className="settings-actions">
              <TestConnectionButton service="xtream" />
              <button className="secondary" onClick={() => disconnectXtream().then(refreshStatus)}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <CredentialForm
            title="Xtream Codes"
            description="Log in with the credentials your IPTV provider gave you."
            onSubmit={async (baseUrl, username, password) => {
              await saveXtream(baseUrl, username, password);
              refreshStatus();
            }}
          />
        )}
      </section>

      <section className="settings-card settings-card-tmdb">
        <div className="settings-card-header">
          <h2>TMDB</h2>
          {status.tmdb && <span className="badge connected">Connected</span>}
        </div>
        {status.tmdb ? (
          <>
            <p className="settings-desc">Powers the Popular Movies and Popular Shows shelves on On Demand.</p>
            <div className="settings-actions">
              <TestConnectionButton service="tmdb" />
              <button className="secondary" onClick={() => disconnectTmdb().then(refreshStatus)}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <TokenForm
            description="Paste your TMDB API Read Access Token (free at themoviedb.org/settings/api) to power the Popular Movies and Popular Shows shelves."
            placeholder="eyJhbGciOi..."
            buttonLabel="Connect TMDB"
            onSubmit={async (token) => {
              await saveTmdb(token);
              refreshStatus();
            }}
          />
        )}
      </section>

      <section className="settings-card settings-card-trakt">
        <div className="settings-card-header">
          <h2>Trakt</h2>
          {status.trakt && <span className="badge connected">Connected</span>}
          {!status.trakt && status.traktConfigured && <span className="badge">Not linked</span>}
        </div>
        {status.trakt ? (
          <>
            <p className="settings-desc">
              Adds Trakt ratings and reviews to the detail page, plus your Watchlist and personal
              recommendations as shelves on On Demand.
            </p>
            <div className="settings-actions">
              <TestConnectionButton service="trakt" />
              <button
                className="secondary"
                onClick={() => disconnectTrakt().then(refreshStatus)}
              >
                Disconnect
              </button>
            </div>
          </>
        ) : status.traktConfigured ? (
          traktLink.phase === "waiting" ? (
            <div className="plex-link">
              {traktLink.userCode ? (
                <>
                  <p>
                    1. Open{" "}
                    <a href={traktLink.verificationUrl || "https://trakt.tv/activate"} target="_blank" rel="noreferrer">
                      {traktLink.verificationUrl || "trakt.tv/activate"}
                    </a>
                  </p>
                  <p>
                    2. Enter this code: <strong className="link-code">{traktLink.userCode}</strong>
                  </p>
                  <p className="settings-desc">Waiting for you to authorize…</p>
                </>
              ) : (
                <p className="settings-desc">Starting link request…</p>
              )}
            </div>
          ) : (
            <>
              <p className="settings-desc">Client ID and Secret saved. Now link your Trakt account.</p>
              <button onClick={beginTraktLink}>Link Trakt Account</button>
              <button
                className="secondary"
                onClick={() => disconnectTrakt().then(refreshStatus)}
                style={{ marginLeft: 10 }}
              >
                Start Over
              </button>
            </>
          )
        ) : (
          <ClientCredentialForm
            description={
              "Register a free API app at trakt.tv/oauth/applications (redirect URI urn:ietf:wg:oauth:2.0:oob), then paste its Client ID and Secret here."
            }
            onSubmit={async (clientId, clientSecret) => {
              await saveTrakt(clientId, clientSecret);
              refreshStatus();
            }}
          />
        )}
        {traktLink.phase === "error" && <div className="settings-error">{traktLink.message}</div>}
      </section>
      <p className="settings-version">Unified Media Hub {APP_VERSION}</p>
    </div>
  );
}
