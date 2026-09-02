# Security

Forkcast is a local-first static application. It does not transmit workspace data, load third-party scripts, or require API keys.

## Trust boundaries

- User-authored evidence and notes are treated as untrusted text.
- Destructive option removal is reversible through undo and is recorded in the activity trail with the removed option’s name and score snapshot; no ceremonial confirmation flag is used because an agent would set it reflexively.
- Agent undo succeeds only when the latest reversible change was agent-authored; otherwise it returns a readable error.
- WebMCP tools may stage a recommendation, but no Forkcast site tool can commit a final decision.
- Final commitment is reserved for the visible review control and explicit user confirmation in the page.
- Committed workspaces unregister mutation tools and disable visible editing controls.
- The application uses a restrictive Content Security Policy and avoids HTML injection for workspace content.
- The page refuses native tool registration when it is embedded in a frame; `_headers` additionally provides `X-Frame-Options: DENY` and `frame-ancestors 'none'` for hosts that honor it.
- Native WebMCP relies on browser defaults (`tools` permissions policy defaults to `self`; agent clusters are origin-keyed by default). `_headers` restates them explicitly for header-capable hosts such as Netlify or Cloudflare Pages.

The decision gate is an application authority boundary, not an identity or authentication mechanism. It prevents commitment through Forkcast’s WebMCP surface; it does not claim to distinguish a person from every possible browser-automation system with control of the page.

Neither the production host (ChatGPT Sites) nor GitHub Pages applies the project-defined `_headers`; the production deployment is verified with `npm run check:prod` instead. The GitHub Pages deployment is documented as a visual and Tool Lab preview only; native WebMCP testing and the challenge submission use the production URL.

Please report vulnerabilities privately through GitHub's security advisory feature rather than a public issue.
