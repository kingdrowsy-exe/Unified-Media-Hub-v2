# Security

Report a vulnerability privately to the maintainer (GitHub security advisories on
this repository, or the address on the commit history). Do not open a public issue
that contains a Plex token, an Xtream or Silo password, a Trakt secret, or a copy
of `settings.json`.

The desktop app keeps credentials in `%APPDATA%\Unified Media Hub\data\settings.json`,
encrypted with Electron safeStorage when the installed app is running. The API binds
to `127.0.0.1` only.
