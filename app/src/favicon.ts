/**
 * Agent Flow favicon: an orchestrator node wired to three subagents, on the app's
 * #0a0a1a background. Inlined as a data URI so it also shows on the login page
 * (a separate /favicon request would be blocked by the password gate).
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs>
<radialGradient id="o" cx="38%" cy="34%" r="70%"><stop offset="0" stop-color="#c4f1ff"/><stop offset=".45" stop-color="#5ec8ff"/><stop offset="1" stop-color="#3b6cf6"/></radialGradient>
<filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter>
</defs>
<rect width="64" height="64" rx="14" fill="#0a0a1a"/>
<g stroke="#6d8cff" stroke-opacity=".7" stroke-width="4.5" stroke-linecap="round">
<path d="M32 31L13 13M32 31L51 13M32 31V52"/>
</g>
<circle cx="32" cy="31" r="15" fill="#3b82f6" opacity=".55" filter="url(#g)"/>
<circle cx="13" cy="13" r="9" fill="#a78bfa"/>
<circle cx="51" cy="13" r="9" fill="#34d399"/>
<circle cx="32" cy="53" r="9" fill="#fbbf24"/>
<circle cx="32" cy="31" r="13" fill="url(#o)"/>
</svg>`

export const FAVICON_DATA_URI = 'data:image/svg+xml,' + encodeURIComponent(FAVICON_SVG)

export const FAVICON_LINK_TAGS = `<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">`
