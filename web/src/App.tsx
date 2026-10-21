import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import Live from "./pages/Live.js";
import OnDemand from "./pages/OnDemand.js";
import Search from "./pages/Search.js";
import Settings from "./pages/Settings.js";
import { fetchSettingsStatus } from "./api.js";
import { APP_VERSION } from "./appVersion.js";

export default function App() {
  const [defaultRoute, setDefaultRoute] = useState<string | null>(null);

  useEffect(() => {
    fetchSettingsStatus()
      .then((status) => {
        const anyConfigured = status.plex || status.silo || status.xtream;
        setDefaultRoute(anyConfigured ? "/ondemand" : "/settings");
      })
      .catch(() => setDefaultRoute("/ondemand"));
  }, []);

  return (
    <div className="app-shell">
      <nav className="nav">
        <div className="nav-side">
          <NavLink to="/ondemand" className="nav-brand" aria-label="Unified Media Hub">
            <img src="/logo.svg" alt="" width={32} height={32} />
          </NavLink>
          <span className="nav-version">v{APP_VERSION}</span>
        </div>
        <div className="nav-inner">
          <NavLink to="/ondemand" className={({ isActive }) => (isActive ? "active" : "")}>
            On Demand
          </NavLink>
          <NavLink to="/search" className={({ isActive }) => (isActive ? "active" : "")}>
            Search
          </NavLink>
          <NavLink to="/live" className={({ isActive }) => (isActive ? "active" : "")}>
            Live TV
          </NavLink>
        </div>
        <NavLink
          to="/settings"
          className={({ isActive }) => `nav-settings ${isActive ? "active" : ""}`}
          aria-label="Settings"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M19.4 13.5c.04-.33.06-.66.06-1s-.02-.67-.06-1l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.4 7.4 0 00-1.73-1l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.63.24-1.22.58-1.73 1l-2.39-.96a.5.5 0 00-.6.22L2.65 9.28a.5.5 0 00.12.64L4.8 11.5c-.04.33-.06.66-.06 1s.02.67.06 1l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.51.42 1.1.76 1.73 1l.36 2.54c.04.25.25.42.5.42h3.84c.25 0 .46-.17.5-.42l.36-2.54c.63-.24 1.22-.58 1.73-1l2.39.96c.22.09.48 0 .6-.22l1.92-3.32a.5.5 0 00-.12-.64L19.4 13.5z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        </NavLink>
      </nav>
      <div className="app-routes">
        <Routes>
          <Route
            path="/"
            element={defaultRoute ? <Navigate to={defaultRoute} replace /> : null}
          />
          <Route path="/live" element={<Live />} />
          <Route path="/ondemand" element={<OnDemand />} />
          <Route path="/search" element={<Search />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </div>
    </div>
  );
}
