# couples-album

Encrypted couples photo album (no login) hosted on GitHub Pages with Firebase backend.

## Viewer
Open the GitHub Pages URL and enter the passphrase.

## Admin uploader (PC)
Open:
`/#admin?token=YOUR_ADMIN_TOKEN`

- Enter the same passphrase as the viewer.
- Select photos to upload.

## Firebase
This app uses:
- Firestore: encrypted metadata
- Storage: encrypted blobs

### Firestore rules
Paste the rules from the Copilot chat into Firebase → Firestore → Rules.

### Storage rules
Paste the rules from the Copilot chat into Firebase → Storage → Rules.

## Notes
- Anyone can download the encrypted blobs, but without the passphrase they are useless.
- Keep your admin token private.
