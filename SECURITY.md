# Security, safety and privacy

## Physical safety (read first)

- **The motor starts by itself.** With the project settings it spins `autostart_delay` seconds (10) after a battery is plugged in, then ramps to `autostart_throttle`. Remove the propeller or blower wheel on the bench; treat a powered device as live.
- **Never more than 8S on the flight controller's `B` pin.** The red wire carries the battery voltage; a short to a signal wire destroys the processor.
- **Ground use only.** This is a motor driver configuration, not a flight setup.
- What stops the program, and every setting: [`docs/settings.md`](docs/settings.md). Operational risks: [`docs/warnings.md`](docs/warnings.md).

## What leaves your computer (web configurator, https://autostart.flyreelstudio.eu)

- **The board's settings and live data: never.** The page talks to the flight controller over Web Serial inside your browser.
- **Feedback** (bug / idea / collaboration) — only when you send it: your text and, if you type one, a contact. Text and contact are stored on the site's server in the EU and forwarded to the author's Telegram (Telegram FZ-LLC, Dubai — outside the EEA). Kept up to 12 months.
- **Technical details with a bug report** — only if the checkbox is ticked: page version, browser and screen, the last errors, the configurator's log of this visit. The server additionally strips any key that could name a file or a person.
- **Cookieless counters** (page views, counted outbound links `/go/<slug>`, configurator events such as "connected") — daily totals only, no IP addresses, no identifiers. Server logs keep no IP addresses and no query strings.
- **Google Analytics** — only after you accept it in the banner (and only if the site has a GA4 id configured).

## Server side

The hosted site is two small containers: `nginx:1.29-alpine` serving static files and a stdlib-only Python API (`site/api/server.py`). No upload endpoint exists; request bodies are capped (8 KB, 512 KB for reports with diagnostics), rate-limited per client and globally, and the API container is read-only with a 64 MB memory cap. Content-Security-Policy forbids inline scripts and third-party scripts except Google Tag Manager (loaded only after consent); Permissions-Policy allows only `serial`, `usb` and `screen-wake-lock` for the site itself.

## Firmware

The module only writes into the throttle values Betaflight's Motors tab uses while disarmed; arming, a valid receiver link, the CLI and the Motors tab always take precedence and stop the program. It never takes a pin owned by another driver. Flashing any firmware can reset settings; keep a `diff all` of your configuration.

## Reporting a vulnerability or a safety problem

Email **zmei116@gmail.com** with "SECURITY" in the subject. Please do not open a public issue for vulnerabilities. You will get an answer within a few days.

## Self-hosting

- Never commit `site/deploy/hub.env`, `config.env`, `site/tools/reports/inbox/` or `site/api/data/` (all in `.gitignore`).
- Telegram credentials belong only in `config.env` on the server (mode 600).
- Run a secret scan before every push, e.g. `git grep -iE 'password|secret|token|api[_-]?key|BEGIN .*PRIVATE KEY|ghp_|github_pat_' $(git rev-list --all)`.
