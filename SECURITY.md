# Security Policy

## Scope
This repository contains an encrypted photo album web app hosted on GitHub Pages with a Firebase (Firestore + Storage) backend.

If you believe you’ve found a security vulnerability that could expose private data (e.g., decrypted images/metadata), bypass encryption, or enable unauthorized admin actions, please report it privately.

## Supported Versions
Only the latest deployment from the `main` branch is supported.

## Reporting a Vulnerability
Preferred (private):
- Use GitHub’s **Private vulnerability reporting** / **Security Advisories** for this repository (Security tab → “Report a vulnerability”), if available.

If the private reporting option is not available:
- Open a **GitHub Security Advisory** for this repository, or
- Contact the maintainer privately (avoid posting sensitive details publicly).

## Please Do Not Disclose Publicly
To protect users, please do **not** include any of the following in public issues/discussions/PRs:
- Admin token URLs (e.g. `/#admin?token=...`)
- Album passphrases
- Decrypted image bytes, decrypted metadata, or screenshots of sensitive content
- Firebase credentials that provide privileged access (e.g., service account keys)

## Notes on Secrets
- The Firebase web config values in `src/config.js` (e.g., `apiKey`, `projectId`) are **not secrets** by themselves for client-side Firebase apps.
- Secrets that **must** remain private include:
  - Admin tokens used by this app
  - Any passphrases
  - Any Firebase/Google Cloud **service account keys** or privileged API keys
