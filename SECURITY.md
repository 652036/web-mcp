# Security

Forkcast is a local-first static application. It does not transmit workspace data, load third-party scripts, or require API keys.

## Trust boundaries

- User-authored evidence and notes are treated as untrusted text.
- Destructive option removal requires an explicit `confirm: true` argument.
- Agent undo is available only when the latest reversible change was agent-authored.
- WebMCP tools may stage a recommendation, but no Forkcast site tool can commit a final decision.
- Final commitment is reserved for the visible review control and explicit user confirmation in the page.
- Committed workspaces unregister mutation tools and disable visible editing controls.
- The application uses a restrictive Content Security Policy and avoids HTML injection for workspace content.
- Header-capable deployments opt into an origin-keyed agent cluster and restrict the `tools` permissions policy to self.

The decision gate is an application authority boundary, not an identity or authentication mechanism. It prevents commitment through Forkcast’s WebMCP surface; it does not claim to distinguish a person from every possible browser-automation system with control of the page.

GitHub Pages does not preserve Forkcast’s custom response headers. That deployment is documented as a visual and Tool Lab preview only; native WebMCP testing and the challenge submission must use the header-capable deployment.

Please report vulnerabilities privately through GitHub's security advisory feature rather than a public issue.
