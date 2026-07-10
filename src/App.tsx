import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";

type DriverState = {
  lat: number;
  lon: number;
  heading: number;
  velocity: number;
};

type HudState = DriverState & {
  speedMph: number;
};

type Position = {
  lat: number;
  lon: number;
};

type RouteStatus = "No route" | "Drawing" | "Ready" | "Autopilot" | "Arrived";

type SnapStatus = "Off" | "Finding road" | "On road" | "No road" | "OSRM unavailable";

type LocationStatus = "Off" | "Waiting" | "Looking up" | "Located" | "Unavailable";

type LocationFix = {
  id: number;
  label: string;
  street: string;
  town: string;
};

type PointOfInterest = {
  id: number;
  name: string;
  description: string;
  lat: number;
  lon: number;
  address: string;
};

type VisitedTown = {
  key: string;
  name: string;
  label: string;
  lat: number;
  lon: number;
  firstVisitedAt: number;
  lastVisitedAt: number;
  visitCount: number;
};

type VisitedPoi = {
  poiId: number;
  name: string;
  description: string;
  address: string;
  lat: number;
  lon: number;
  firstVisitedAt: number;
  lastVisitedAt: number;
  visitCount: number;
  lastXpAwardedAt?: number;
};

type ProgressSave = {
  xp: number;
  visitedTowns: VisitedTown[];
  visitedPois: VisitedPoi[];
  spawnPoint: Position;
};

type ProgressTab = "anchors" | "towns" | "stats";
type AnchorFilter = "teleportable" | "recent" | "all";
type AnchorSort = "recent" | "name" | "distance";
type TownSort = "recent" | "name";
type CommandMode = "go" | "route" | "anchor";

type OsrmNearestResponse = {
  code: string;
  waypoints?: Array<{
    distance: number;
    location: [number, number];
    name?: string;
  }>;
};

type NominatimReverseResponse = {
  display_name?: string;
  address?: {
    road?: string;
    pedestrian?: string;
    footway?: string;
    cycleway?: string;
    path?: string;
    neighbourhood?: string;
    suburb?: string;
    quarter?: string;
    city_district?: string;
    borough?: string;
    village?: string;
    town?: string;
    city?: string;
    municipality?: string;
    county?: string;
    state?: string;
    postcode?: string;
  };
};

type NominatimSearchResult = {
  lat: string;
  lon: string;
  display_name?: string;
};

const HOME = {
  lat: 40.6629,
  lon: -73.5515,
  heading: 40,
  velocity: 0,
};

const MAX_MANUAL_MPH = 150;
const MAX_CRUISE_MPH = 500;
const MAX_MANUAL_FORWARD_SPEED = 67.056;
const MAX_CRUISE_FORWARD_SPEED = 223.694;
const MAX_REVERSE_SPEED = -10;
const ACCELERATION = 16;
const BRAKE_ACCELERATION = 24;
const FRICTION = 3.2;
const TURN_RATE = 128;
const FOLLOW_ZOOM = 17;
const EARTH_METERS_PER_DEGREE = 111_320;
const SNAP_REQUEST_INTERVAL_MS = 420;
const SNAP_BLEND_RATE = 12;
const LOCATION_LOOKUP_INTERVAL_MS = 10_000;
const LOCATION_LOOKUP_DISTANCE_METERS = 120;
const ROUTE_ARRIVAL_DISTANCE_METERS = 8;
const DEFAULT_AUTOPILOT_MPH = 35;
const POI_STORAGE_KEY = "route-one-points-of-interest";
const PROGRESS_STORAGE_KEY = "route-one-progress";
const TOWN_VISIT_XP = 10;
const ANCHOR_VISIT_XP = 5;
const TELEPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
const POI_VISIT_DISTANCE_METERS = 70;
const PROGRESS_RESULT_LIMIT = 100;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const normalizeHeading = (heading: number) => ((heading % 360) + 360) % 360;

const metersPerSecondToMph = (value: number) => value * 2.23694;

const mphToMetersPerSecond = (value: number) => value / 2.23694;

const lerp = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return entities[character];
  });

const blurActiveControl = () => {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
};

const getTownKey = (town: string) => town.trim().toLowerCase();

const isRecentVisit = (timestamp: number) =>
  Date.now() - timestamp <= TELEPORT_WINDOW_MS;

const formatVisitAge = (timestamp: number) => {
  const elapsedMs = Date.now() - timestamp;
  const elapsedMinutes = Math.max(1, Math.floor(elapsedMs / 60_000));

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  return `${Math.floor(elapsedHours / 24)}d ago`;
};

const getDistanceMeters = (from: Position, to: Position) => {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const deltaLat = ((to.lat - from.lat) * Math.PI) / 180;
  const deltaLon = ((to.lon - from.lon) * Math.PI) / 180;
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const getBearingDegrees = (from: Position, to: Position) => {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const deltaLon = ((to.lon - from.lon) * Math.PI) / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);

  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
};

const moveByHeading = (
  lat: number,
  lon: number,
  headingDegrees: number,
  meters: number,
) => {
  const heading = (headingDegrees * Math.PI) / 180;
  const northMeters = Math.cos(heading) * meters;
  const eastMeters = Math.sin(heading) * meters;
  const nextLat = lat + northMeters / EARTH_METERS_PER_DEGREE;
  const nextLon =
    lon +
    eastMeters /
      (EARTH_METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180));

  return { lat: nextLat, lon: nextLon };
};

const createCarIcon = () =>
  L.divIcon({
    className: "car-marker-shell",
    html: '<div class="car-marker"></div>',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });

export default function App() {
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);
  const routeStartRef = useRef<L.CircleMarker | null>(null);
  const routeEndRef = useRef<L.CircleMarker | null>(null);
  const poiMarkersRef = useRef<Map<number, L.Marker>>(new Map());
  const carElementRef = useRef<HTMLElement | null>(null);
  const driverRef = useRef<DriverState>({ ...HOME });
  const displayPositionRef = useRef<Position>({ lat: HOME.lat, lon: HOME.lon });
  const snapTargetRef = useRef<Position>({ lat: HOME.lat, lon: HOME.lon });
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const lastFrameRef = useRef<number | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastSnapRequestRef = useRef(0);
  const pendingSnapRef = useRef(false);
  const snapRequestIdRef = useRef(0);
  const pendingLocationRef = useRef(false);
  const locationRequestIdRef = useRef(0);
  const lastLocationLookupRef = useRef(0);
  const lastLocationPositionRef = useRef<Position | null>(null);
  const routePointsRef = useRef<Position[]>([]);
  const isRouteDrawModeRef = useRef(false);
  const isAutopilotEnabledRef = useRef(false);
  const autopilotTargetIndexRef = useRef(1);
  const isPoiPlaceModeRef = useRef(false);
  const removePoiRef = useRef<(id: number) => void>(() => undefined);
  const pointsOfInterestRef = useRef<PointOfInterest[]>([]);
  const poiLoadedRef = useRef(false);
  const skipNextPoiSaveRef = useRef(false);
  const progressLoadedRef = useRef(false);
  const skipNextProgressSaveRef = useRef(false);
  const spawnPointRef = useRef<Position>({ lat: HOME.lat, lon: HOME.lon });
  const [isNightMode, setIsNightMode] = useState(false);
  const [isRoadSnapEnabled, setIsRoadSnapEnabled] = useState(false);
  const isRoadSnapEnabledRef = useRef(isRoadSnapEnabled);
  const [isLocationEnabled, setIsLocationEnabled] = useState(false);
  const isLocationEnabledRef = useRef(isLocationEnabled);
  const [isCruiseEnabled, setIsCruiseEnabled] = useState(false);
  const isCruiseEnabledRef = useRef(isCruiseEnabled);
  const [cruiseSpeedMph, setCruiseSpeedMph] = useState(35);
  const cruiseSpeedMphRef = useRef(cruiseSpeedMph);
  const [teleportQuery, setTeleportQuery] = useState("");
  const [teleportStatus, setTeleportStatus] = useState("");
  const [snapStatus, setSnapStatus] = useState<SnapStatus>("Off");
  const [snapDistance, setSnapDistance] = useState<number | null>(null);
  const [roadName, setRoadName] = useState("");
  const roadNameRef = useRef("");
  const [locationStatus, setLocationStatus] = useState<LocationStatus>("Off");
  const [currentLocation, setCurrentLocation] = useState<LocationFix | null>(null);
  const [locationHistory, setLocationHistory] = useState<LocationFix[]>([]);
  const [isRouteDrawMode, setIsRouteDrawMode] = useState(false);
  const [isAutopilotEnabled, setIsAutopilotEnabled] = useState(false);
  const [routeStatus, setRouteStatus] = useState<RouteStatus>("No route");
  const [routePointCount, setRoutePointCount] = useState(0);
  const [isPoiPlaceMode, setIsPoiPlaceMode] = useState(false);
  const [poiName, setPoiName] = useState("");
  const [poiDescription, setPoiDescription] = useState("");
  const poiNameRef = useRef("");
  const poiDescriptionRef = useRef("");
  const [poiStatus, setPoiStatus] = useState("");
  const [pointsOfInterest, setPointsOfInterest] = useState<PointOfInterest[]>([]);
  const [xp, setXp] = useState(0);
  const [visitedTowns, setVisitedTowns] = useState<VisitedTown[]>([]);
  const [visitedPois, setVisitedPois] = useState<VisitedPoi[]>([]);
  const [spawnPoint, setSpawnPoint] = useState<Position>({
    lat: HOME.lat,
    lon: HOME.lon,
  });
  const [isProgressMenuOpen, setIsProgressMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [commandMode, setCommandMode] = useState<CommandMode>("go");
  const [progressTab, setProgressTab] = useState<ProgressTab>("anchors");
  const [progressSearch, setProgressSearch] = useState("");
  const [anchorFilter, setAnchorFilter] = useState<AnchorFilter>("teleportable");
  const [anchorSort, setAnchorSort] = useState<AnchorSort>("recent");
  const [townSort, setTownSort] = useState<TownSort>("recent");
  const [progressStatus, setProgressStatus] = useState("");
  const [xpToast, setXpToast] = useState("");
  const [hud, setHud] = useState<HudState>({
    ...HOME,
    speedMph: 0,
  });
  const carIcon = useMemo(() => createCarIcon(), []);

  const poiIcon = useMemo(
    () =>
      L.divIcon({
        className: "poi-marker-shell",
        html: '<div class="poi-marker"></div>',
        iconSize: [24, 24],
        iconAnchor: [12, 22],
      }),
    [],
  );
  const normalizedProgressSearch = progressSearch.trim().toLowerCase();
  const anchorStats = useMemo(() => {
    const teleportableCount = visitedPois.filter((poi) =>
      isRecentVisit(poi.lastVisitedAt),
    ).length;

    return {
      total: visitedPois.length,
      teleportable: teleportableCount,
      expired: visitedPois.length - teleportableCount,
    };
  }, [visitedPois]);
  const filteredAnchors = useMemo(() => {
    const currentPosition = displayPositionRef.current;
    const filtered = visitedPois.filter((poi) => {
      const isTeleportable = isRecentVisit(poi.lastVisitedAt);
      const matchesFilter =
        anchorFilter === "all" ||
        (anchorFilter === "teleportable" && isTeleportable) ||
        (anchorFilter === "recent" && Date.now() - poi.lastVisitedAt <= TELEPORT_WINDOW_MS * 7);
      const matchesSearch =
        !normalizedProgressSearch ||
        [poi.name, poi.address, poi.description]
          .join(" ")
          .toLowerCase()
          .includes(normalizedProgressSearch);

      return matchesFilter && matchesSearch;
    });

    filtered.sort((a, b) => {
      const aTeleportable = Number(isRecentVisit(a.lastVisitedAt));
      const bTeleportable = Number(isRecentVisit(b.lastVisitedAt));
      if (aTeleportable !== bTeleportable) {
        return bTeleportable - aTeleportable;
      }

      if (anchorSort === "name") {
        return a.name.localeCompare(b.name);
      }

      if (anchorSort === "distance") {
        return (
          getDistanceMeters(currentPosition, a) -
          getDistanceMeters(currentPosition, b)
        );
      }

      return b.lastVisitedAt - a.lastVisitedAt;
    });

    return filtered;
  }, [anchorFilter, anchorSort, normalizedProgressSearch, visitedPois]);
  const visibleAnchors = filteredAnchors.slice(0, PROGRESS_RESULT_LIMIT);
  const filteredTowns = useMemo(() => {
    const filtered = visitedTowns.filter((town) => {
      if (!normalizedProgressSearch) {
        return true;
      }

      return [town.name, town.label]
        .join(" ")
        .toLowerCase()
        .includes(normalizedProgressSearch);
    });

    filtered.sort((a, b) =>
      townSort === "name"
        ? a.name.localeCompare(b.name)
        : b.lastVisitedAt - a.lastVisitedAt,
    );

    return filtered;
  }, [normalizedProgressSearch, townSort, visitedTowns]);
  const visibleTowns = filteredTowns.slice(0, PROGRESS_RESULT_LIMIT);

  const showXpToast = useCallback((message: string) => {
    setXpToast(message);
    window.setTimeout(() => {
      setXpToast((currentMessage) =>
        currentMessage === message ? "" : currentMessage,
      );
    }, 3600);
  }, []);

  const recordTownVisit = useCallback((fix: LocationFix, position: Position) => {
    const townName = fix.town.trim();
    if (!townName || townName === "Unknown town") {
      return;
    }

    const now = Date.now();
    const key = getTownKey(townName);

    setVisitedTowns((towns) => {
      const existingTown = towns.find((town) => town.key === key);
      if (existingTown) {
        return [
          {
            ...existingTown,
            label: fix.label,
            lat: position.lat,
            lon: position.lon,
            lastVisitedAt: now,
            visitCount: existingTown.visitCount + 1,
          },
          ...towns.filter((town) => town.key !== key),
        ];
      }

      setXp((currentXp) => currentXp + TOWN_VISIT_XP);
      setProgressStatus(`+${TOWN_VISIT_XP} XP: discovered ${townName}`);
      showXpToast(`+${TOWN_VISIT_XP} XP · New town: ${townName}`);

      return [
        {
          key,
          name: townName,
          label: fix.label,
          lat: position.lat,
          lon: position.lon,
          firstVisitedAt: now,
          lastVisitedAt: now,
          visitCount: 1,
        },
        ...towns,
      ];
    });

    spawnPointRef.current = position;
    setSpawnPoint(position);
  }, [showXpToast]);

  const recordPoiVisit = useCallback((poi: PointOfInterest) => {
    const now = Date.now();

    setVisitedPois((pois) => {
      const existingPoi = pois.find((visitedPoi) => visitedPoi.poiId === poi.id);
      if (existingPoi) {
        if (now - existingPoi.lastVisitedAt < 10 * 60 * 1000) {
          return pois;
        }

        const shouldAwardXp =
          !existingPoi.lastXpAwardedAt ||
          now - existingPoi.lastXpAwardedAt > TELEPORT_WINDOW_MS;

        if (shouldAwardXp) {
          setXp((currentXp) => currentXp + ANCHOR_VISIT_XP);
          setProgressStatus(`+${ANCHOR_VISIT_XP} XP: Anchor visit ${poi.name}`);
          showXpToast(`+${ANCHOR_VISIT_XP} XP · Anchor visit: ${poi.name}`);
        }

        return [
          {
            ...existingPoi,
            name: poi.name,
            description: poi.description,
            address: poi.address,
            lat: poi.lat,
            lon: poi.lon,
            lastVisitedAt: now,
            lastXpAwardedAt: shouldAwardXp
              ? now
              : existingPoi.lastXpAwardedAt,
            visitCount: existingPoi.visitCount + 1,
          },
          ...pois.filter((visitedPoi) => visitedPoi.poiId !== poi.id),
        ];
      }

      setXp((currentXp) => currentXp + ANCHOR_VISIT_XP);
      setProgressStatus(`+${ANCHOR_VISIT_XP} XP: Anchor visit ${poi.name}`);
      showXpToast(`+${ANCHOR_VISIT_XP} XP · Anchor visit: ${poi.name}`);

      return [
        {
          poiId: poi.id,
          name: poi.name,
          description: poi.description,
          address: poi.address,
          lat: poi.lat,
          lon: poi.lon,
          firstVisitedAt: now,
          lastVisitedAt: now,
          lastXpAwardedAt: now,
          visitCount: 1,
        },
        ...pois,
      ];
    });
  }, [showXpToast]);

  const checkPoiVisits = useCallback(
    (position: Position) => {
      pointsOfInterestRef.current.forEach((poi) => {
        if (
          getDistanceMeters(position, poi) <= POI_VISIT_DISTANCE_METERS
        ) {
          recordPoiVisit(poi);
        }
      });
    },
    [recordPoiVisit],
  );

  const addPoiMarker = useCallback(
    (poi: PointOfInterest) => {
      const map = mapRef.current;

      if (!map || poiMarkersRef.current.has(poi.id)) {
        return;
      }

      const marker = L.marker([poi.lat, poi.lon], {
        icon: poiIcon,
        title: poi.name,
      }).bindPopup(
        `<strong>${escapeHtml(poi.name)}</strong><br>${escapeHtml(
          poi.description || "No description",
        )}<br><small>${escapeHtml(
          poi.address,
        )}</small><br><button type="button" class="poi-popup-remove" data-poi-id="${poi.id}">Remove Anchor</button>`,
      );

      marker.on("popupopen", () => {
        const popupElement = marker.getPopup()?.getElement();
        const button = popupElement?.querySelector<HTMLButtonElement>(
          ".poi-popup-remove",
        );

        button?.addEventListener(
          "click",
          () => removePoiRef.current(poi.id),
          { once: true },
        );
      });

      marker.addTo(map);
      poiMarkersRef.current.set(poi.id, marker);
    },
    [poiIcon],
  );

  const syncRouteLayer = useCallback((points: Position[]) => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const latLngs = points.map((point) => L.latLng(point.lat, point.lon));

    if (!routeLineRef.current) {
      routeLineRef.current = L.polyline(latLngs, {
        color: "#186f65",
        weight: 6,
        opacity: 0.86,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(map);
    } else {
      routeLineRef.current.setLatLngs(latLngs);
    }

    if (points.length > 0) {
      const start = L.latLng(points[0].lat, points[0].lon);
      if (!routeStartRef.current) {
        routeStartRef.current = L.circleMarker(start, {
          radius: 6,
          color: "#0f3f39",
          fillColor: "#ffffff",
          fillOpacity: 1,
          weight: 3,
        }).addTo(map);
      } else {
        routeStartRef.current.setLatLng(start);
      }
    } else if (routeStartRef.current) {
      routeStartRef.current.removeFrom(map);
      routeStartRef.current = null;
    }

    if (points.length > 1) {
      const endPoint = points[points.length - 1];
      const end = L.latLng(endPoint.lat, endPoint.lon);
      if (!routeEndRef.current) {
        routeEndRef.current = L.circleMarker(end, {
          radius: 7,
          color: "#0f3f39",
          fillColor: "#e83f35",
          fillOpacity: 1,
          weight: 3,
        }).addTo(map);
      } else {
        routeEndRef.current.setLatLng(end);
      }
    } else if (routeEndRef.current) {
      routeEndRef.current.removeFrom(map);
      routeEndRef.current = null;
    }
  }, []);

  const setRoutePoints = useCallback(
    (points: Position[]) => {
      routePointsRef.current = points;
      setRoutePointCount(points.length);
      syncRouteLayer(points);

      if (points.length === 0) {
        setRouteStatus("No route");
        return;
      }

      if (isAutopilotEnabledRef.current) {
        setRouteStatus("Autopilot");
      } else if (!isRouteDrawModeRef.current) {
        setRouteStatus(points.length > 1 ? "Ready" : "Drawing");
      }
    },
    [syncRouteLayer],
  );

  const clearRoute = useCallback(() => {
    const map = mapRef.current;
    routePointsRef.current = [];
    autopilotTargetIndexRef.current = 1;
    isAutopilotEnabledRef.current = false;
    setIsAutopilotEnabled(false);
    setRoutePointCount(0);
    setRouteStatus("No route");

    if (map && routeLineRef.current) {
      routeLineRef.current.removeFrom(map);
    }
    if (map && routeStartRef.current) {
      routeStartRef.current.removeFrom(map);
    }
    if (map && routeEndRef.current) {
      routeEndRef.current.removeFrom(map);
    }

    routeLineRef.current = null;
    routeStartRef.current = null;
    routeEndRef.current = null;
  }, []);

  const addRouteWaypoint = useCallback(
    (position: Position) => {
      setRoutePoints([...routePointsRef.current, position]);
    },
    [setRoutePoints],
  );

  const undoRouteWaypoint = useCallback(() => {
    const nextPoints = routePointsRef.current.slice(0, -1);
    setRoutePoints(nextPoints);

    if (autopilotTargetIndexRef.current >= nextPoints.length) {
      autopilotTargetIndexRef.current = Math.max(1, nextPoints.length - 1);
    }

    if (nextPoints.length < 2) {
      setIsAutopilotEnabled(false);
      isAutopilotEnabledRef.current = false;
    }
  }, [setRoutePoints]);

  const requestRoadSnap = useCallback(async (position: Position) => {
    if (pendingSnapRef.current) {
      return;
    }

    pendingSnapRef.current = true;
    const requestId = snapRequestIdRef.current + 1;
    snapRequestIdRef.current = requestId;
    setSnapStatus((currentStatus) =>
      currentStatus === "On road" ? currentStatus : "Finding road",
    );

    try {
      const params = new URLSearchParams({ number: "1" });
      const response = await fetch(
        `https://router.project-osrm.org/nearest/v1/driving/${position.lon},${position.lat}?${params}`,
      );

      if (!response.ok) {
        throw new Error(`OSRM responded with ${response.status}`);
      }

      const data = (await response.json()) as OsrmNearestResponse;
      const waypoint = data.waypoints?.[0];

      if (requestId !== snapRequestIdRef.current) {
        return;
      }

      if (data.code !== "Ok" || !waypoint) {
        setSnapStatus("No road");
        setSnapDistance(null);
        setRoadName("");
        roadNameRef.current = "";
        return;
      }

      const [lon, lat] = waypoint.location;
      snapTargetRef.current = { lat, lon };
      setSnapStatus("On road");
      setSnapDistance(waypoint.distance);
      setRoadName(waypoint.name ?? "");
      roadNameRef.current = waypoint.name ?? "";
    } catch {
      if (requestId === snapRequestIdRef.current) {
        setSnapStatus("OSRM unavailable");
        setSnapDistance(null);
        setRoadName("");
        roadNameRef.current = "";
      }
    } finally {
      pendingSnapRef.current = false;
    }
  }, []);

  const requestLocationLookup = useCallback(async (position: Position) => {
    if (pendingLocationRef.current) {
      return;
    }

    pendingLocationRef.current = true;
    const requestId = locationRequestIdRef.current + 1;
    locationRequestIdRef.current = requestId;
    setLocationStatus("Looking up");

    try {
      const params = new URLSearchParams({
        lat: String(position.lat),
        lon: String(position.lon),
        format: "jsonv2",
        addressdetails: "1",
        zoom: "18",
      });
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?${params}`,
      );

      if (!response.ok) {
        throw new Error(`Nominatim responded with ${response.status}`);
      }

      const data = (await response.json()) as NominatimReverseResponse;

      if (requestId !== locationRequestIdRef.current) {
        return;
      }

      const address = data.address ?? {};
      const reverseStreet =
        address.road ??
        address.pedestrian ??
        address.footway ??
        address.cycleway ??
        address.path ??
        "";
      const street =
        isRoadSnapEnabledRef.current && roadNameRef.current
          ? roadNameRef.current
          : reverseStreet;
      const town =
        address.neighbourhood ??
        address.suburb ??
        address.quarter ??
        address.city_district ??
        address.borough ??
        address.village ??
        address.town ??
        address.municipality ??
        address.city ??
        address.county ??
        "";
      const fallback = data.display_name?.split(",").slice(0, 2).join(", ") ?? "";
      const label =
        street && town ? `${street}, ${town}` : street || town || fallback || "Unknown location";
      const nextFix: LocationFix = {
        id: Date.now(),
        label,
        street: street || "Unknown street",
        town: town || address.state || "Unknown town",
      };

      setCurrentLocation(nextFix);
      setLocationStatus("Located");
      recordTownVisit(nextFix, position);
      setLocationHistory((history) => {
        if (history[0]?.label === nextFix.label) {
          return history;
        }

        return [nextFix, ...history].slice(0, 4);
      });
    } catch {
      if (requestId === locationRequestIdRef.current) {
        setLocationStatus("Unavailable");
      }
    } finally {
      pendingLocationRef.current = false;
    }
  }, [recordTownVisit]);

  const getEstimatedAddress = useCallback(async (position: Position) => {
    const params = new URLSearchParams({
      lat: String(position.lat),
      lon: String(position.lon),
      format: "jsonv2",
      addressdetails: "1",
      zoom: "18",
    });
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?${params}`,
    );

    if (!response.ok) {
      throw new Error(`Nominatim responded with ${response.status}`);
    }

    const data = (await response.json()) as NominatimReverseResponse;
    const address = data.address ?? {};
    const street =
      address.road ??
      address.pedestrian ??
      address.footway ??
      address.cycleway ??
      address.path ??
      "";
    const place =
      address.neighbourhood ??
      address.suburb ??
      address.quarter ??
      address.city_district ??
      address.borough ??
      address.village ??
      address.town ??
      address.municipality ??
      address.city ??
      address.county ??
      "";
    const region = [address.state, address.postcode].filter(Boolean).join(" ");

    return (
      [street, place, region].filter(Boolean).join(", ") ||
      data.display_name ||
      "Estimated address unavailable"
    );
  }, []);

  const addPointOfInterest = useCallback(
    async (position: Position) => {
      const map = mapRef.current;
      const name = poiNameRef.current.trim();

      if (!name) {
        setPoiStatus("Name required");
        return;
      }

      if (!map) {
        setPoiStatus("Map unavailable");
        return;
      }

      setPoiStatus("Estimating address...");

      let address = "Estimated address unavailable";
      try {
        address = await getEstimatedAddress(position);
      } catch {
        address = "Estimated address unavailable";
      }

      const poi: PointOfInterest = {
        id: Date.now(),
        name,
        description: poiDescriptionRef.current.trim(),
        lat: position.lat,
        lon: position.lon,
        address,
      };
      addPoiMarker(poi);
      setPointsOfInterest((pois) => [poi, ...pois]);
      recordPoiVisit(poi);
      setPoiStatus(`Anchored ${name}`);
      setPoiName("");
      setPoiDescription("");
      setIsPoiPlaceMode(false);
      isPoiPlaceModeRef.current = false;
      blurActiveControl();
    },
    [addPoiMarker, getEstimatedAddress, recordPoiVisit],
  );

  const removePointOfInterest = useCallback((id: number) => {
    const marker = poiMarkersRef.current.get(id);

    if (marker) {
      marker.remove();
      poiMarkersRef.current.delete(id);
    }

    setPointsOfInterest((pois) => pois.filter((poi) => poi.id !== id));
  }, []);

  useEffect(() => {
    removePoiRef.current = removePointOfInterest;
  }, [removePointOfInterest]);

  useEffect(() => {
    pointsOfInterestRef.current = pointsOfInterest;
    pointsOfInterest.forEach(addPoiMarker);
  }, [addPoiMarker, pointsOfInterest]);

  useEffect(() => {
    spawnPointRef.current = spawnPoint;
  }, [spawnPoint]);

  useEffect(() => {
    try {
      const storedPois = window.localStorage.getItem(POI_STORAGE_KEY);
      if (!storedPois) {
        poiLoadedRef.current = true;
        return;
      }

      const parsedPois = JSON.parse(storedPois) as PointOfInterest[];
      const validPois = parsedPois.filter(
        (poi) =>
          typeof poi.id === "number" &&
          typeof poi.name === "string" &&
          typeof poi.description === "string" &&
          typeof poi.lat === "number" &&
          typeof poi.lon === "number" &&
          typeof poi.address === "string" &&
          Number.isFinite(poi.lat) &&
          Number.isFinite(poi.lon),
      );

      setPointsOfInterest(validPois);
      validPois.forEach(addPoiMarker);
      skipNextPoiSaveRef.current = true;
      poiLoadedRef.current = true;
    } catch {
      window.localStorage.removeItem(POI_STORAGE_KEY);
      poiLoadedRef.current = true;
    }
  }, [addPoiMarker]);

  useEffect(() => {
    if (!poiLoadedRef.current) {
      return;
    }

    if (skipNextPoiSaveRef.current) {
      skipNextPoiSaveRef.current = false;
      return;
    }

    window.localStorage.setItem(
      POI_STORAGE_KEY,
      JSON.stringify(pointsOfInterest),
    );
  }, [pointsOfInterest]);

  useEffect(() => {
    try {
      const storedProgress = window.localStorage.getItem(PROGRESS_STORAGE_KEY);
      if (!storedProgress) {
        progressLoadedRef.current = true;
        return;
      }

      const parsedProgress = JSON.parse(storedProgress) as Partial<ProgressSave>;
      const validTowns = Array.isArray(parsedProgress.visitedTowns)
        ? parsedProgress.visitedTowns.filter(
            (town): town is VisitedTown =>
              typeof town.key === "string" &&
              typeof town.name === "string" &&
              typeof town.label === "string" &&
              typeof town.lat === "number" &&
              typeof town.lon === "number" &&
              typeof town.firstVisitedAt === "number" &&
              typeof town.lastVisitedAt === "number" &&
              typeof town.visitCount === "number",
          )
        : [];
      const validPois = Array.isArray(parsedProgress.visitedPois)
        ? parsedProgress.visitedPois.filter(
            (poi): poi is VisitedPoi =>
              typeof poi.poiId === "number" &&
              typeof poi.name === "string" &&
              typeof poi.description === "string" &&
              typeof poi.address === "string" &&
              typeof poi.lat === "number" &&
              typeof poi.lon === "number" &&
              typeof poi.firstVisitedAt === "number" &&
              typeof poi.lastVisitedAt === "number" &&
              typeof poi.visitCount === "number" &&
              (poi.lastXpAwardedAt === undefined ||
                typeof poi.lastXpAwardedAt === "number"),
          )
        : [];
      const savedSpawn = parsedProgress.spawnPoint;
      const validSpawn =
        savedSpawn &&
        typeof savedSpawn.lat === "number" &&
        typeof savedSpawn.lon === "number" &&
        Number.isFinite(savedSpawn.lat) &&
        Number.isFinite(savedSpawn.lon)
          ? savedSpawn
          : { lat: HOME.lat, lon: HOME.lon };

      setXp(
        typeof parsedProgress.xp === "number" &&
          Number.isFinite(parsedProgress.xp)
          ? parsedProgress.xp
          : 0,
      );
      setVisitedTowns(validTowns);
      setVisitedPois(validPois);
      spawnPointRef.current = validSpawn;
      setSpawnPoint(validSpawn);
      skipNextProgressSaveRef.current = true;
      progressLoadedRef.current = true;
    } catch {
      window.localStorage.removeItem(PROGRESS_STORAGE_KEY);
      progressLoadedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!progressLoadedRef.current) {
      return;
    }

    if (skipNextProgressSaveRef.current) {
      skipNextProgressSaveRef.current = false;
      return;
    }

    const progress: ProgressSave = {
      xp,
      visitedTowns,
      visitedPois,
      spawnPoint,
    };

    window.localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  }, [spawnPoint, visitedPois, visitedTowns, xp]);

  const moveInstantlyTo = useCallback(
    (position: Position, heading = driverRef.current.heading) => {
      driverRef.current = {
        lat: position.lat,
        lon: position.lon,
        heading,
        velocity: 0,
      };
      displayPositionRef.current = position;
      snapTargetRef.current = position;
      lastSnapRequestRef.current = 0;
      lastLocationLookupRef.current = 0;
      lastLocationPositionRef.current = null;
      pressedKeysRef.current.clear();
      setIsCruiseEnabled(false);
      setIsAutopilotEnabled(false);
      isAutopilotEnabledRef.current = false;

      const latLng = L.latLng(position.lat, position.lon);
      markerRef.current?.setLatLng(latLng);
      mapRef.current?.setView(latLng, FOLLOW_ZOOM, { animate: true });

      if (carElementRef.current) {
        carElementRef.current.style.transform = `rotate(${heading}deg)`;
      }

      setHud({
        lat: position.lat,
        lon: position.lon,
        heading,
        velocity: 0,
        speedMph: 0,
      });

      if (isRoadSnapEnabledRef.current) {
        setSnapStatus("Finding road");
        void requestRoadSnap(position);
      }

      if (isLocationEnabledRef.current) {
        setLocationStatus("Looking up");
        void requestLocationLookup(position);
      }

      checkPoiVisits(position);
    },
    [checkPoiVisits, requestLocationLookup, requestRoadSnap],
  );

  const teleportToQuery = async () => {
    const query = teleportQuery.trim();

    if (!query) {
      setTeleportStatus("Enter a place");
      return;
    }

    setTeleportStatus("Searching...");

    try {
      const params = new URLSearchParams({
        q: query,
        format: "jsonv2",
        limit: "1",
        addressdetails: "1",
      });
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
      );

      if (!response.ok) {
        throw new Error(`Nominatim responded with ${response.status}`);
      }

      const results = (await response.json()) as NominatimSearchResult[];
      const result = results[0];

      if (!result) {
        setTeleportStatus("No match");
        return;
      }

      const lat = Number(result.lat);
      const lon = Number(result.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        setTeleportStatus("Bad result");
        return;
      }

      moveInstantlyTo({ lat, lon });
      setTeleportStatus(result.display_name?.split(",").slice(0, 2).join(", ") ?? "Teleported");
    } catch {
      setTeleportStatus("Search unavailable");
    }
  };

  useEffect(() => {
    isRoadSnapEnabledRef.current = isRoadSnapEnabled;

    if (isRoadSnapEnabled) {
      setSnapStatus("Finding road");
      lastSnapRequestRef.current = 0;
      void requestRoadSnap(driverRef.current);
      return;
    }

    snapRequestIdRef.current += 1;
    pendingSnapRef.current = false;
    displayPositionRef.current = {
      lat: driverRef.current.lat,
      lon: driverRef.current.lon,
    };
    snapTargetRef.current = displayPositionRef.current;
    setSnapStatus("Off");
    setSnapDistance(null);
    setRoadName("");
    roadNameRef.current = "";
  }, [isRoadSnapEnabled, requestRoadSnap]);

  useEffect(() => {
    isLocationEnabledRef.current = isLocationEnabled;

    if (isLocationEnabled) {
      setLocationStatus("Waiting");
      lastLocationLookupRef.current = performance.now() - LOCATION_LOOKUP_INTERVAL_MS;
      lastLocationPositionRef.current = null;
      return;
    }

    locationRequestIdRef.current += 1;
    pendingLocationRef.current = false;
    setLocationStatus("Off");
  }, [isLocationEnabled]);

  useEffect(() => {
    isCruiseEnabledRef.current = isCruiseEnabled;
  }, [isCruiseEnabled]);

  useEffect(() => {
    poiNameRef.current = poiName;
  }, [poiName]);

  useEffect(() => {
    poiDescriptionRef.current = poiDescription;
  }, [poiDescription]);

  useEffect(() => {
    isPoiPlaceModeRef.current = isPoiPlaceMode;

    if (isPoiPlaceMode) {
      setIsRouteDrawMode(false);
      isRouteDrawModeRef.current = false;
      mapRef.current?.dragging.enable();
      setPoiStatus(poiName.trim() ? "Click map to place" : "Enter a name first");
    }
  }, [isPoiPlaceMode, poiName]);

  useEffect(() => {
    cruiseSpeedMphRef.current = cruiseSpeedMph;
  }, [cruiseSpeedMph]);

  useEffect(() => {
    isRouteDrawModeRef.current = isRouteDrawMode;

    if (isRouteDrawMode) {
      setRouteStatus(isAutopilotEnabledRef.current ? "Autopilot" : "Drawing");
      mapRef.current?.dragging.disable();
      return;
    }

    mapRef.current?.dragging.enable();
    setRouteStatus(
      isAutopilotEnabledRef.current
        ? "Autopilot"
        : routePointsRef.current.length > 1
          ? "Ready"
          : "No route",
    );
  }, [isRouteDrawMode]);

  useEffect(() => {
    isAutopilotEnabledRef.current = isAutopilotEnabled;

    if (isAutopilotEnabled) {
      autopilotTargetIndexRef.current = 1;
      setRouteStatus("Autopilot");
      return;
    }

    if (routeStatus === "Autopilot") {
      setRouteStatus(routePointsRef.current.length > 1 ? "Ready" : "No route");
    }
  }, [isAutopilotEnabled, routeStatus]);

  useEffect(() => {
    if (mapRef.current) {
      return;
    }

    const map = L.map("map", {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
    }).setView([HOME.lat, HOME.lon], FOLLOW_ZOOM);

    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control
      .attribution({ position: "bottomleft", prefix: false })
      .addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')
      .addTo(map);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(map);

    const marker = L.marker([HOME.lat, HOME.lon], {
      icon: carIcon,
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(map);

    markerRef.current = marker;
    mapRef.current = map;
    carElementRef.current = marker.getElement()?.querySelector(".car-marker") ?? null;
    pointsOfInterestRef.current.forEach(addPoiMarker);

    const toPosition = (event: L.LeafletMouseEvent): Position => ({
      lat: event.latlng.lat,
      lon: event.latlng.lng,
    });

    const handleAddWaypoint = (event: L.LeafletMouseEvent) => {
      if (isPoiPlaceModeRef.current) {
        isPoiPlaceModeRef.current = false;
        setIsPoiPlaceMode(false);
        setPoiStatus("Placing...");
        map.dragging.enable();
        blurActiveControl();
        void addPointOfInterest(toPosition(event));
        return;
      }

      if (!isRouteDrawModeRef.current) {
        return;
      }

      addRouteWaypoint(toPosition(event));
    };

    const handleUndoWaypoint = (event: L.LeafletMouseEvent) => {
      if (!isRouteDrawModeRef.current) {
        return;
      }

      event.originalEvent.preventDefault();
      undoRouteWaypoint();
    };

    map.on("click", handleAddWaypoint);
    map.on("contextmenu", handleUndoWaypoint);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      map.off("click", handleAddWaypoint);
      map.off("contextmenu", handleUndoWaypoint);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      carElementRef.current = null;
    };
  }, [addPointOfInterest, addPoiMarker, addRouteWaypoint, carIcon, undoRouteWaypoint]);

  useEffect(() => {
    const keys = pressedKeysRef.current;

    const normalizeKey = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        return "Space";
      }
      return event.key.length === 1 ? event.key.toLowerCase() : event.key;
    };

    const shouldCaptureKey = (key: string) =>
      ["w", "a", "s", "d", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight", "Space"].includes(key);

    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }

      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const key = normalizeKey(event);

      if (key === "Escape") {
        event.preventDefault();
        setIsPoiPlaceMode(false);
        setIsRouteDrawMode(false);
        isPoiPlaceModeRef.current = false;
        isRouteDrawModeRef.current = false;
        mapRef.current?.dragging.enable();
        setPoiStatus((status) =>
          status === "Click map to place" || status === "Enter a name first"
            ? ""
            : status,
        );
        setRouteStatus(
          isAutopilotEnabledRef.current
            ? "Autopilot"
            : routePointsRef.current.length > 1
              ? "Ready"
              : routePointsRef.current.length === 1
                ? "Drawing"
                : "No route",
        );
        blurActiveControl();
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      if (!shouldCaptureKey(key)) {
        return;
      }

      event.preventDefault();
      keys.add(key);

      if (key === "s" || key === "ArrowDown") {
        setIsCruiseEnabled(false);
        setIsAutopilotEnabled(false);
        isAutopilotEnabledRef.current = false;
      }

      if (key === "Space") {
        driverRef.current.velocity = 0;
        setIsCruiseEnabled(false);
        setIsAutopilotEnabled(false);
        isAutopilotEnabledRef.current = false;
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = normalizeKey(event);
      if (isTypingTarget(event.target)) {
        return;
      }

      if (shouldCaptureKey(key)) {
        event.preventDefault();
        keys.delete(key);
      }
    };

    window.addEventListener("keydown", handleKeyDown, { passive: false });
    window.addEventListener("keyup", handleKeyUp, { passive: false });

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  useEffect(() => {
    const tick = (timestamp: number) => {
      if (lastFrameRef.current === null) {
        lastFrameRef.current = timestamp;
      }

      const deltaSeconds = Math.min(
        (timestamp - lastFrameRef.current) / 1000,
        0.05,
      );
      lastFrameRef.current = timestamp;

      const keys = pressedKeysRef.current;
      const driver = driverRef.current;
      const accelerating = keys.has("w") || keys.has("ArrowUp");
      const braking = keys.has("s") || keys.has("ArrowDown");
      const turningLeft = keys.has("a") || keys.has("ArrowLeft");
      const turningRight = keys.has("d") || keys.has("ArrowRight");
      const turnInput = Number(turningRight) - Number(turningLeft);
      const speedTurnFactor = clamp(Math.abs(driver.velocity) / 5, 0.35, 1);
      const hasAutopilotRoute =
        isAutopilotEnabledRef.current && routePointsRef.current.length > 1;
      const cruiseTarget =
        hasAutopilotRoute
          ? mphToMetersPerSecond(
              isCruiseEnabledRef.current
                ? cruiseSpeedMphRef.current
                : DEFAULT_AUTOPILOT_MPH,
            )
          : isCruiseEnabledRef.current && !accelerating && !braking
            ? mphToMetersPerSecond(cruiseSpeedMphRef.current)
            : null;

      if (!hasAutopilotRoute && accelerating) {
        driver.velocity += ACCELERATION * deltaSeconds;
      }

      if (!hasAutopilotRoute && braking) {
        driver.velocity -= BRAKE_ACCELERATION * deltaSeconds;
      }

      if (cruiseTarget !== null) {
        const cruiseDelta = cruiseTarget - driver.velocity;
        const cruiseStep =
          (cruiseDelta > 0 ? ACCELERATION : BRAKE_ACCELERATION * 0.55) *
          deltaSeconds;

        driver.velocity =
          Math.abs(cruiseDelta) <= cruiseStep
            ? cruiseTarget
            : driver.velocity + Math.sign(cruiseDelta) * cruiseStep;
      } else if (!accelerating && !braking && driver.velocity !== 0) {
        const frictionStep = FRICTION * deltaSeconds * Math.sign(driver.velocity);
        driver.velocity =
          Math.abs(frictionStep) > Math.abs(driver.velocity)
            ? 0
            : driver.velocity - frictionStep;
      }

      driver.velocity = clamp(
        driver.velocity,
        MAX_REVERSE_SPEED,
        cruiseTarget !== null ? MAX_CRUISE_FORWARD_SPEED : MAX_MANUAL_FORWARD_SPEED,
      );

      if (!hasAutopilotRoute && turnInput !== 0) {
        const reverseMultiplier = driver.velocity < 0 ? -1 : 1;
        driver.heading = normalizeHeading(
          driver.heading +
            turnInput * TURN_RATE * speedTurnFactor * reverseMultiplier * deltaSeconds,
        );
      }

      if (hasAutopilotRoute) {
        let distanceToTravel = Math.max(driver.velocity, 0) * deltaSeconds;
        let targetIndex = autopilotTargetIndexRef.current;
        const routePoints = routePointsRef.current;

        while (distanceToTravel > 0 && targetIndex < routePoints.length) {
          const currentPosition = { lat: driver.lat, lon: driver.lon };
          const target = routePoints[targetIndex];
          const distanceToTarget = getDistanceMeters(currentPosition, target);

          if (distanceToTarget <= ROUTE_ARRIVAL_DISTANCE_METERS) {
            targetIndex += 1;
            continue;
          }

          driver.heading = getBearingDegrees(currentPosition, target);

          if (distanceToTravel >= distanceToTarget) {
            driver.lat = target.lat;
            driver.lon = target.lon;
            distanceToTravel -= distanceToTarget;
            targetIndex += 1;
          } else {
            const nextPosition = moveByHeading(
              driver.lat,
              driver.lon,
              driver.heading,
              distanceToTravel,
            );
            driver.lat = nextPosition.lat;
            driver.lon = nextPosition.lon;
            distanceToTravel = 0;
          }
        }

        autopilotTargetIndexRef.current = targetIndex;

        if (targetIndex >= routePoints.length) {
          driver.velocity = 0;
          setIsAutopilotEnabled(false);
          isAutopilotEnabledRef.current = false;
          setRouteStatus("Arrived");
        }
      } else {
        const nextPosition = moveByHeading(
          driver.lat,
          driver.lon,
          driver.heading,
          driver.velocity * deltaSeconds,
        );

        driver.lat = nextPosition.lat;
        driver.lon = nextPosition.lon;
      }

      const now = performance.now();
      const shouldSnap =
        isRoadSnapEnabledRef.current &&
        Math.abs(driver.velocity) > 0.25 &&
        now - lastSnapRequestRef.current > SNAP_REQUEST_INTERVAL_MS;

      if (shouldSnap) {
        lastSnapRequestRef.current = now;
        void requestRoadSnap(driver);
      }

      const shouldCheckLocation =
        isLocationEnabledRef.current &&
        Math.abs(driver.velocity) > 0.5 &&
        now - lastLocationLookupRef.current > LOCATION_LOOKUP_INTERVAL_MS &&
        (!lastLocationPositionRef.current ||
          getDistanceMeters(lastLocationPositionRef.current, driver) >
            LOCATION_LOOKUP_DISTANCE_METERS);

      if (shouldCheckLocation) {
        lastLocationLookupRef.current = now;
        lastLocationPositionRef.current = { lat: driver.lat, lon: driver.lon };
        void requestLocationLookup(driver);
      }

      let displayPosition: Position = { lat: driver.lat, lon: driver.lon };

      if (isRoadSnapEnabledRef.current) {
        const blendAmount = clamp(deltaSeconds * SNAP_BLEND_RATE, 0, 1);

        displayPosition = {
          lat: lerp(
            displayPositionRef.current.lat,
            snapTargetRef.current.lat,
            blendAmount,
          ),
          lon: lerp(
            displayPositionRef.current.lon,
            snapTargetRef.current.lon,
            blendAmount,
          ),
        };
      }

      displayPositionRef.current = displayPosition;
      checkPoiVisits(displayPosition);

      const latLng = L.latLng(displayPosition.lat, displayPosition.lon);
      markerRef.current?.setLatLng(latLng);
      mapRef.current?.panTo(latLng, {
        animate: true,
        duration: 0.18,
        easeLinearity: 0.35,
      });

      if (carElementRef.current) {
        carElementRef.current.style.transform = `rotate(${driver.heading}deg)`;
      }

      setHud({
        ...driver,
        lat: displayPosition.lat,
        lon: displayPosition.lon,
        speedMph: Math.abs(metersPerSecondToMph(driver.velocity)),
      });

      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      lastFrameRef.current = null;
    };
  }, [checkPoiVisits, requestLocationLookup, requestRoadSnap]);

  const resetToSpawn = () => {
    moveInstantlyTo(spawnPointRef.current, HOME.heading);
    setTeleportStatus("");
  };

  const teleportToProgressPoint = (position: Position, label: string) => {
    moveInstantlyTo(position);
    setProgressStatus(`Teleported to ${label}`);
  };

  return (
    <main
      className={[
        "app",
        isNightMode ? "app-night" : "",
        isRouteDrawMode ? "app-drawing-route" : "",
        isPoiPlaceMode ? "app-placing-poi" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div id="map" aria-label="Drivable OpenStreetMap view" />

      <section className="hud" aria-label="Driver telemetry">
        <div className="hud-primary">
          <div>
            <span>Speed</span>
            <strong>{hud.speedMph.toFixed(1)}</strong>
            <small>mph</small>
          </div>
          <div className="hud-road">
            <span>{currentLocation ? "Current location" : "Nearest road"}</span>
            <strong>{currentLocation?.label || roadName || "Exploring the map"}</strong>
          </div>
        </div>
        <div className="hud-status-row">
          <span className={isCruiseEnabled ? "status-chip active" : "status-chip"}>
            Cruise {isCruiseEnabled ? `${cruiseSpeedMph}` : "off"}
          </span>
          <span
            className={
              isAutopilotEnabled ? "status-chip autopilot" : "status-chip"
            }
          >
            {routeStatus}
            {routePointCount > 0 ? ` / ${routePointCount} pts` : ""}
          </span>
          <span className="status-chip">{xp} XP</span>
        </div>
        <details className="hud-details">
          <summary>Driver details</summary>
          <dl>
            <div><dt>Position</dt><dd>{hud.lat.toFixed(5)}, {hud.lon.toFixed(5)}</dd></div>
            <div><dt>Heading</dt><dd>{Math.round(hud.heading)} deg</dd></div>
            <div><dt>Road snap</dt><dd>{snapStatus}{snapDistance !== null ? ` / ${snapDistance.toFixed(0)} m` : ""}</dd></div>
            <div><dt>Location</dt><dd>{locationStatus}</dd></div>
          </dl>
        </details>
      </section>

      {isPoiPlaceMode ? (
        <aside className="mode-banner anchor-mode" aria-live="polite">
          <span>Anchor mode</span>
          <strong>Click the map to place {poiName}</strong>
          <button type="button" onClick={() => setIsPoiPlaceMode(false)}>Cancel</button>
        </aside>
      ) : isRouteDrawMode ? (
        <aside className="mode-banner route-mode" aria-live="polite">
          <span>Route mode</span>
          <strong>Click to add waypoints / right-click to undo</strong>
          <button type="button" onClick={() => setIsRouteDrawMode(false)}>Done</button>
        </aside>
      ) : isAutopilotEnabled ? (
        <aside className="mode-banner autopilot-mode" aria-live="polite">
          <span>Autopilot active</span>
          <strong>Following route at {isCruiseEnabled ? cruiseSpeedMph : 35} mph</strong>
          <button type="button" onClick={() => setIsAutopilotEnabled(false)}>Stop</button>
        </aside>
      ) : null}

      {xpToast ? (
        <aside className="xp-toast" aria-live="polite">
          {xpToast}
        </aside>
      ) : null}

      {isProgressMenuOpen ? (
        <aside className="progress-menu" aria-label="Progress menu">
          <header className="progress-header">
            <div>
              <span>XP</span>
              <strong>{xp}</strong>
            </div>
            <button type="button" onClick={() => setIsProgressMenuOpen(false)}>
              Close
            </button>
          </header>

          {progressStatus ? <p className="progress-status">{progressStatus}</p> : null}

          <nav className="progress-tabs" aria-label="Progress sections">
            {(["anchors", "towns", "stats"] as ProgressTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                className={progressTab === tab ? "active" : ""}
                onClick={() => setProgressTab(tab)}
              >
                {tab === "anchors" ? "Anchors" : tab === "towns" ? "Towns" : "Stats"}
              </button>
            ))}
          </nav>

          {progressTab !== "stats" ? (
            <input
              className="progress-search"
              aria-label="Search progress"
              type="search"
              placeholder={
                progressTab === "anchors"
                  ? "Search anchors..."
                  : "Search towns..."
              }
              value={progressSearch}
              onChange={(event) => setProgressSearch(event.target.value)}
            />
          ) : null}

          {progressTab === "anchors" ? (
            <section>
              <div className="progress-toolbar">
                <div className="segmented">
                  {(["teleportable", "recent", "all"] as AnchorFilter[]).map(
                    (filter) => (
                      <button
                        key={filter}
                        type="button"
                        className={anchorFilter === filter ? "active" : ""}
                        onClick={() => setAnchorFilter(filter)}
                      >
                        {filter === "teleportable"
                          ? "Teleportable"
                          : filter === "recent"
                            ? "Recent"
                            : "All"}
                      </button>
                    ),
                  )}
                </div>
                <select
                  aria-label="Sort anchors"
                  value={anchorSort}
                  onChange={(event) =>
                    setAnchorSort(event.target.value as AnchorSort)
                  }
                >
                  <option value="recent">Recent</option>
                  <option value="name">Name</option>
                  <option value="distance">Distance</option>
                </select>
              </div>
              <p className="result-count">
                Showing {visibleAnchors.length} of {filteredAnchors.length}
              </p>
              {visibleAnchors.length === 0 ? (
                <p>
                  Place an Anchor, then drive near it to unlock 24-hour
                  teleport.
                </p>
              ) : (
                visibleAnchors.map((poi) => {
                  const canTeleport = isRecentVisit(poi.lastVisitedAt);

                  return (
                    <div key={poi.poiId} className="progress-row">
                      <div>
                        <strong>{poi.name}</strong>
                        <span>
                          {poi.address} · {formatVisitAge(poi.lastVisitedAt)}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={!canTeleport}
                        onClick={() =>
                          teleportToProgressPoint(
                            { lat: poi.lat, lon: poi.lon },
                            poi.name,
                          )
                        }
                      >
                        Teleport
                      </button>
                    </div>
                  );
                })
              )}
            </section>
          ) : null}

          {progressTab === "towns" ? (
            <section>
              <div className="progress-toolbar">
                <h2>Towns</h2>
                <select
                  aria-label="Sort towns"
                  value={townSort}
                  onChange={(event) => setTownSort(event.target.value as TownSort)}
                >
                  <option value="recent">Recent</option>
                  <option value="name">Name</option>
                </select>
              </div>
              <p className="result-count">
                Showing {visibleTowns.length} of {filteredTowns.length}
              </p>
              {visibleTowns.length === 0 ? (
                <p>Turn on Location and drive into towns to discover them.</p>
              ) : (
                visibleTowns.map((town) => {
                  const isRecent = isRecentVisit(town.lastVisitedAt);

                  return (
                    <div key={town.key} className="progress-row progress-row-static">
                      <div>
                        <strong>{town.name}</strong>
                        <span>
                          {town.label} · {formatVisitAge(town.lastVisitedAt)}
                        </span>
                      </div>
                      <span>{isRecent ? "Recent" : "Archived"}</span>
                    </div>
                  );
                })
              )}
            </section>
          ) : null}

          {progressTab === "stats" ? (
            <section>
              <div className="stats-grid">
                <div>
                  <span>XP</span>
                  <strong>{xp}</strong>
                </div>
                <div>
                  <span>Towns</span>
                  <strong>{visitedTowns.length}</strong>
                </div>
                <div>
                  <span>Anchors Placed</span>
                  <strong>{pointsOfInterest.length}</strong>
                </div>
                <div>
                  <span>Anchors Visited</span>
                  <strong>{anchorStats.total}</strong>
                </div>
                <div>
                  <span>Teleportable</span>
                  <strong>{anchorStats.teleportable}</strong>
                </div>
                <div>
                  <span>Spawn</span>
                  <strong>
                    {spawnPoint.lat.toFixed(3)}, {spawnPoint.lon.toFixed(3)}
                  </strong>
                </div>
              </div>
            </section>
          ) : null}
        </aside>
      ) : null}

      <div className="settings-cluster" aria-label="Map controls">
        <button type="button" onClick={() => setIsProgressMenuOpen(true)}>
          Progress <span className="xp-badge">{xp}</span>
        </button>
        <button
          type="button"
          aria-expanded={isSettingsOpen}
          onClick={() => setIsSettingsOpen((open) => !open)}
        >
          Settings
        </button>
        {isSettingsOpen ? (
          <div className="settings-menu">
            <button className="settings-progress-button" type="button" onClick={() => { setIsProgressMenuOpen(true); setIsSettingsOpen(false); }}>Progress / {xp} XP</button>
            <label className="switch-row"><span>Night map</span><input type="checkbox" checked={isNightMode} onChange={(event) => setIsNightMode(event.target.checked)} /><i /></label>
            <label className="switch-row"><span>Road snap</span><input type="checkbox" checked={isRoadSnapEnabled} onChange={(event) => setIsRoadSnapEnabled(event.target.checked)} /><i /></label>
            <label className="switch-row"><span>Location</span><input type="checkbox" checked={isLocationEnabled} onChange={(event) => setIsLocationEnabled(event.target.checked)} /><i /></label>
            <button className="reset-button" type="button" onClick={resetToSpawn}>Reset to spawn</button>
          </div>
        ) : null}
      </div>

      <section className="command-bar" aria-label="Map command bar">
        <nav className="command-tabs" aria-label="Command type">
          {(["go", "route", "anchor"] as CommandMode[]).map((mode) => (
            <button key={mode} type="button" className={commandMode === mode ? "active" : ""} onClick={() => setCommandMode(mode)}>
              {mode === "go" ? "Go to" : mode === "route" ? "Route" : "Add anchor"}
            </button>
          ))}
        </nav>

        {commandMode === "go" ? (
          <form className="command-content go-command" aria-label="Teleport to location" onSubmit={(event) => { event.preventDefault(); void teleportToQuery(); }}>
            <input aria-label="Teleport destination" type="search" placeholder="Search an address or place" value={teleportQuery} onChange={(event) => setTeleportQuery(event.target.value)} />
            <button className="primary-action" type="submit">Go</button>
            {teleportStatus ? <span className="command-status">{teleportStatus}</span> : null}
          </form>
        ) : commandMode === "route" ? (
          <div className="command-content route-command">
            <button className={isRouteDrawMode ? "mode-action active" : "mode-action"} type="button" onClick={() => setIsRouteDrawMode((active) => !active)}>{isRouteDrawMode ? "Finish drawing" : "Draw route"}</button>
            <button className={isAutopilotEnabled ? "mode-action autopilot-active" : "mode-action"} type="button" disabled={routePointCount < 2} onClick={() => setIsAutopilotEnabled((active) => !active)}>{isAutopilotEnabled ? "Stop autopilot" : "Autopilot"}</button>
            <label className="cruise-control"><input type="checkbox" checked={isCruiseEnabled} onChange={(event) => setIsCruiseEnabled(event.target.checked)} /><span>Cruise</span><input aria-label="Cruise speed in miles per hour" type="number" min="0" max={MAX_CRUISE_MPH} step="1" value={cruiseSpeedMph} onChange={(event) => { const nextValue = Number(event.target.value); setCruiseSpeedMph(Number.isFinite(nextValue) ? clamp(Math.round(nextValue), 0, MAX_CRUISE_MPH) : 0); }} /><span>mph</span></label>
            <button className="quiet-action" type="button" disabled={routePointCount === 0} onClick={clearRoute}>Clear</button>
          </div>
        ) : (
          <form className="command-content anchor-command" aria-label="Add anchor" onSubmit={(event) => { event.preventDefault(); if (!poiName.trim()) { setPoiStatus("Name required"); return; } setIsPoiPlaceMode(true); }}>
            <input aria-label="Anchor name" type="text" placeholder="Anchor name" value={poiName} onChange={(event) => setPoiName(event.target.value)} />
            <input aria-label="Anchor description" type="text" placeholder="Optional description" value={poiDescription} onChange={(event) => setPoiDescription(event.target.value)} />
            <button className="primary-action anchor-action" type="submit" disabled={!poiName.trim() || isPoiPlaceMode}>{isPoiPlaceMode ? "Click map" : "Place"}</button>
            {poiStatus ? <span className="command-status">{poiStatus}</span> : null}
          </form>
        )}
      </section>
    </main>
  );
}
