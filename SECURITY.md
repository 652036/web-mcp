# Security

Forkcast is a local-first static application. It does not transmit workspace data, load third-party scripts, or require API keys.

## Trust boundaries

- User-authored evidence and notes are treated as untrusted text.
- Destructive option removal requires an explicit `confirm: true` argument.
- WebMCP tools may stage a recommendation, but no tool can commit a final decision.
- Final commitment requires a visible human action in the page.
- The application uses a restrictive Content Security Policy and avoids HTML injection for workspace content.

Please report vulnerabilities privately through GitHub's security advisory feature rather than a public issue.
