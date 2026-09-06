# Route One

Route One is a browser-based driving playground. It renders an interactive OpenStreetMap with Leaflet and lets users drive, teleport, draw waypoint routes, use autopilot, create Anchors, and track locally saved visits and XP.

## Project shape

- React 18 + TypeScript, built with Vite.
- `src/App.tsx` contains most application state, map behavior, driving physics, routing, and persistence.
- `src/styles.css` contains the full-screen map and responsive UI styling.
- Browser data is stored in `localStorage`; there is no backend.
- Road snapping/routing uses public OSRM services. Search and reverse geocoding use public Nominatim services.

## Working here

- Run locally: `npm run dev`
- Validate changes: `npm run build`
- Keep the app client-only and avoid committing generated `dist/` files.
- Preserve keyboard and map controls, responsive layouts, and graceful behavior when external map services or browser storage are unavailable.
