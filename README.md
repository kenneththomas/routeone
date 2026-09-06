# Route One

A browser-based driving playground built with React, TypeScript, Leaflet, and OpenStreetMap.

Drive around the map, teleport to places, create waypoint routes, use autopilot, and save custom Anchors. Progress and visits are stored locally in your browser.

## Run locally

```bash
npm install
npm run dev
```

To create a production build:

```bash
npm run build
```

## Controls

- `W` / `ArrowUp` - accelerate
- `S` / `ArrowDown` - brake or reverse
- `A` / `ArrowLeft` - turn left
- `D` / `ArrowRight` - turn right
- `E` - drop an auto-named Quick Anchor at the current position
- `Space` - stop and disable cruise/autopilot
- Left-click the map - add a waypoint or place an Anchor
- Right-click the map - remove the latest waypoint

Road snapping uses OSRM, while search and location lookup use Nominatim. These features rely on public services and are intended for local/demo use.
