# Route One

Route One is a small client-side MVP that lets the user drive a triangular car marker across an OpenStreetMap/Leaflet map. It can snap the visible marker to nearby roads with OSRM, while keeping routing, traffic, missions, and 3D out of scope for now.

## Tech

- React + TypeScript + Vite
- Leaflet
- OpenStreetMap raster tiles
- OSRM nearest API for road snapping
- Client-side state and animation only

## Getting Started

Install dependencies:

```bash
npm install
```

Run the local dev server:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Controls

- `W` or `ArrowUp`: accelerate forward
- `S` or `ArrowDown`: brake or reverse
- `A` or `ArrowLeft`: rotate left
- `D` or `ArrowRight`: rotate right
- `Space`: stop
- `Cruise`: enter a target mph from `0` to `500`, then enable cruise to hold that speed
- `Teleport`: enter an address or place name and jump there instantly
- `Waypoints`: left-click the map to add route points, right-click to undo the last point
- `Autopilot`: follow the waypoint route
- `Place Anchor`: enter an Anchor name, optional description, then click the map to place it
- `Progress`: search and filter visited Anchors, view towns, stats, XP, and recent teleport options

Braking or pressing `Space` turns cruise control and autopilot off.

## MVP Features

- Map starts centered on Merrick, NY
- Triangular car marker starts at the map center
- Smooth heading and velocity based movement
- Map follows the marker
- Marker rotates to match heading
- HUD displays speed, latitude/longitude, and heading
- Manual acceleration capped at 150 mph
- Cruise control with a typed target speed capped at 500 mph
- Optional road snapping via OSRM nearest API
- HUD displays snap status, snap distance, and nearby road name when available
- Optional location lookup that shows the current street/town and a short recent-location log
- Teleport search for jumping to another address or place
- Manual waypoint route drawing
- Autopilot follows the waypoint route at cruise speed, or 35 mph if cruise is off
- Anchors with name, optional description, marker popup, estimated address, and popup removal
- XP system with persistent town/Anchor visit history
- Reset to spawn button using the latest visited town waypoint
- Simple night mode toggle

## Road Snapping

Road snapping is off by default and can be toggled with the `Snap` control. When enabled, the app calls the public OSRM nearest endpoint at a short interval while the marker is moving, then smoothly blends the visible marker toward the returned road coordinate.

The current throttle is one request every `420ms` while moving, with only one in-flight request allowed at a time. That means one active browser tab tops out around 2.4 OSRM requests per second. This is acceptable for a local MVP, but a production version should use a self-hosted OSRM instance, a paid routing provider, stronger throttling, or a local road graph cache.

The driving model is still intentionally simple: this is nearest-road snapping, not route-following, map matching, lane guidance, or turn-by-turn navigation.

## Location Lookup

Location lookup is off by default and can be toggled with the `Location` control. When enabled, the app reverse-geocodes the current position with Nominatim only while moving, at most once every 10 seconds, and only after the car has moved about 120 meters since the last lookup.

The current location appears as a small `Now on` banner, and the app keeps a short recent-location log. The place label prefers the most local available context first, such as neighbourhood, suburb, quarter, city district, or borough, before falling back to the broader city/town. If road snapping is enabled and OSRM has returned a road name, the location label reuses that snapped road name and uses Nominatim mainly for local place context.

The public Nominatim service has limited capacity and a usage policy. This MVP stays well below the public limit for a single local browser tab, but a production app should use a dedicated geocoding provider or a self-hosted service.

## Teleport

The teleport search uses Nominatim search to jump the car to an address or named place. Teleporting stops the car, turns cruise control off, recenters the map, and refreshes snap/location data if those toggles are enabled.

## Anchors

Anchors are placed from the `Place Anchor` panel. Enter a name, optionally add a description, click `Place Anchor`, then click the map. The app immediately returns to normal driving controls after the map click, drops a marker, and reverse-geocodes the coordinate with Nominatim for an estimated address.

Click an Anchor marker to open its popup. The popup includes its name, description, estimated address, and a remove button.

Anchors are saved in browser `localStorage`, so they persist across refreshes and browser restarts on the same device/browser. They are still client-side only for now, with no backend sync.

## XP And Visits

Progress is saved in browser `localStorage`. Visiting a new town grants `10 XP` and shows an XP popup; revisiting the same town updates its latest visit time but does not grant more town XP. Town visits are detected through the Location lookup, so turn on `Location` while driving to discover towns.

The last visited town waypoint becomes your spawn point. `Reset to spawn` jumps back there.

The `Progress` menu opens to Anchors first because Anchor teleport is the main action. It includes tabs for Anchors, Towns, and Stats. Anchor results can be searched, filtered by teleportability/recent/all, sorted by recent/name/distance, and are capped to the first 100 visible results for performance.

Towns are history/spawn context only and are not directly teleportable. Anchors visited within the last 24 hours can be teleported to from that menu. Older Anchor visits stay visible, but their teleport buttons are disabled.

Anchors become visited when the car gets close to a saved Anchor marker. Placing an Anchor also counts as visiting it. Anchor visits grant `5 XP` when they enter a fresh 24-hour teleport window.

## Manual Routes And Autopilot

Manual routes are drawn with the `Waypoints` toggle. Turn it on, then left-click the map to add route points. Right-click the map to undo the last route point.

You can keep `Waypoints` on while autopilot is running and add more points to the end of the route; autopilot will continue onto the newly added segment.

`Autopilot` follows the waypoint route from the car's current position toward the final point. If cruise control is enabled, autopilot uses the typed cruise speed. If cruise is off, autopilot uses 35 mph. Braking or pressing `Space` cancels autopilot.

## Possible Next Steps

- Route recording and breadcrumb trail
- Controller support
