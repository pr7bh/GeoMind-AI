import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { LoaderCircle, LocateFixed, MapPinOff } from "lucide-react";
import type {
  Feature as GeoJSONFeature,
  FeatureCollection as GeoJSONFeatureCollection,
  Geometry,
} from "geojson";
import Map from "ol/Map";
import Overlay from "ol/Overlay";
import { easeOut, inAndOut } from "ol/easing";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import XYZ from "ol/source/XYZ";
import "ol/ol.css";
import { fromLonLat, toLonLat, transform } from "ol/proj";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import { circular } from "ol/geom/Polygon";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style, Text } from "ol/style";
import type { StyleLike } from "ol/style/Style";
import Draw from "ol/interaction/Draw";
import type { DrawingMode } from "./DrawingToolbar";
import Select from "ol/interaction/Select";
import { click } from "ol/events/condition";
import LineString from "ol/geom/LineString";
import { getArea, getLength, getDistance } from "ol/sphere";
import GeoJSON from "ol/format/GeoJSON";
import { isEmpty } from "ol/extent";
import HeatmapLayer from "ol/layer/Heatmap";
import type SimpleGeometry from "ol/geom/SimpleGeometry";

export interface SelectedFeatureInfo {
  id: string;
  geometryType: string;
  coordinates: unknown;
  coordinatesWGS84: unknown;
  lengthMeters?: number;
  areaSquareMeters?: number;
  perimeterMeters?: number;
  properties?: Record<string, unknown>;
}

export type MapLayerKind = "imported" | "analysis" | "discovery";

export type PickMarkerRole = "start" | "destination" | "reference" | "location";

export type MapPickRequest =
  | {
      mode: "point";
      onPick: (coordinates: [number, number]) => void;
    }
  | {
      mode: "feature";
      geometryTypes?: string[];
      onPick: (feature: GeoJSONFeature) => void;
    };

export interface ImportedLayerInfo {
  id: string;
  name: string;
  count: number;
  geometryTypes: string[];
  visible: boolean;
  kind: MapLayerKind;
  color?: string;
}

export interface ImportedPointInfo {
  layerId: string;
  layerName: string;
  points: {
    coordinates: [number, number];
    featureId: string;
  }[];
}

interface GeoMapProps {
  theme: "light" | "dark";
}

export type BaseMapType = "dark" | "light" | "satellite";

export interface GeoMapHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
  toggleBaseLayer: (visible: boolean) => void;
  isBaseLayerVisible: () => boolean;
  setBaseMap: (type: BaseMapType) => void;
  goToLocation: (longitude: number, latitude: number) => void;
  setDrawingMode: (mode: DrawingMode) => void;
  clearDrawings: () => void;
  setOnFeatureSelect: (
    callback: (feature: SelectedFeatureInfo | null) => void,
  ) => void;
  exportDrawings: () => string;
  importGeoJSON: (content: string) => {
    count: number;
    geometryTypes: string[];
  };
  clearImportedData: () => void;
  getImportedLayers: () => ImportedLayerInfo[];
  setImportedLayerVisibility: (id: string, visible: boolean) => void;
  removeImportedLayer: (id: string) => void;
  zoomToImportedLayer: (id: string) => void;
  addBufferGeoJSON: (geojson: string) => void;
  clearFeatureSelection: () => void;
  getImportedPoints: () => ImportedPointInfo[];
  highlightPointsInPolygon: (coordinates: number[][]) => void;
  clearPointHighlights: () => void;
  getImportedGeoJSON: (layerId: string) => string | null;
  highlightSpatialQueryResults: (features: GeoJSONFeature[]) => void;
  /** Adds an analysis result layer and returns its layer id. */
  addClipResultGeoJSON: (geojson: string, layerName?: string) => string;
  /** Fits the view to GeoJSON features or geometries (WGS84). */
  fitToGeoJSON: (items: (GeoJSONFeature | Geometry)[]) => void;
  startMapPick: (request: MapPickRequest) => void;
  cancelMapPick: () => void;
  setPickMarker: (
    key: string,
    role: PickMarkerRole,
    coordinates: [number, number] | null,
  ) => void;
  highlightNearestFeature: (
    origin: [number, number],
    feature: GeoJSONFeature,
  ) => void;
  clearNearestFeatureHighlight: () => void;
  highlightNearestFeatures: (
    origin: [number, number],
    features: GeoJSONFeature[],
  ) => void;
  setHeatmap: (layerId: string | null, radius: number, blur: number) => void;

  showRouteDistance: (
    start: [number, number],
    destination: [number, number],
  ) => number;

  clearRouteDistance: () => void;
  showRoadRoute: (
  geometry: {
    type: "LineString";
    coordinates: number[][];
  },
) => void;
getNearestFeaturesInput: () => {
  coordinates: [number, number];
  features: Record<string, unknown>[];
} | null;
  getViewCenter: () => [number, number] | null;
  addDiscoveryLayer: (
    collection: GeoJSONFeatureCollection,
    layerName: string,
  ) => ImportedLayerInfo;
  /** Analysis layer coloured per feature by `property` (e.g. coverage class). */
  addClassifiedLayer: (
    collection: GeoJSONFeatureCollection,
    layerName: string,
    property: string,
    palette: Record<string, string>,
    outline?: string,
  ) => ImportedLayerInfo;
  clearDiscoveryLayers: () => void;
}

const SUPPORTED_GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
]);

// Distinct per-layer colours for discovery results.
const DISCOVERY_COLORS = [
  "#f59e0b",
  "#38bdf8",
  "#a78bfa",
  "#f472b6",
  "#a3e635",
  "#22d3ee",
  "#fb923c",
];

const PICK_MARKER_STYLES: Record<PickMarkerRole, { color: string; label: string }> = {
  start: { color: "#10b981", label: "A" },
  destination: { color: "#8b5cf6", label: "B" },
  reference: { color: "#0ea5e9", label: "R" },
  location: { color: "#f59e0b", label: "" },
};

function pickMarkerStyle(role: PickMarkerRole) {
  const { color, label } = PICK_MARKER_STYLES[role];

  return new Style({
    image: new Circle({
      radius: label ? 10 : 7,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: "#ffffff", width: 2.5 }),
    }),
    text: label
      ? new Text({
          text: label,
          font: "700 11px Inter, system-ui, sans-serif",
          fill: new Fill({ color: "#ffffff" }),
        })
      : undefined,
  });
}

function setViewportCursor(map: Map, cursor: string) {
  const viewport = map.getViewport();
  if (viewport) viewport.style.cursor = cursor;
}

function classifiedStyle(color: string, outline?: string) {
  return new Style({
    fill: new Fill({ color: `${color}59` }),
    stroke: new Stroke({ color: outline ?? `${color}cc`, width: outline ? 1.25 : 0.75 }),
    // Point features (e.g. suitability candidates) need an image to render.
    image: new Circle({
      radius: 5,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: "#ffffff", width: 1.25 }),
    }),
  });
}

function discoveryStyle(color: string) {
  return new Style({
    fill: new Fill({ color: `${color}33` }),
    stroke: new Stroke({ color, width: 2.5 }),
    image: new Circle({
      radius: 6,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: "#ffffff", width: 1.5 }),
    }),
  });
}

const INITIAL_CENTER: [number, number] = [0, 0];
const INITIAL_ZOOM = 2;
const USER_LOCATION_ZOOM = 14;
const FLY_DURATION_MS = 2200;

type LocationStatus = "locating" | "found" | "denied" | "unavailable";

const LOCATION_MESSAGES: Record<LocationStatus, string> = {
  locating: "Locating you…",
  found: "You are here",
  denied: "Location access is blocked. Allow it in your browser to start the map at your position.",
  unavailable: "Your location could not be found, so the map shows the world view.",
};

/** Animated flight: pans while zooming, arcing out a little for short hops. */
function flyTo(view: View, center: number[], zoom: number, duration = FLY_DURATION_MS) {
  const startZoom = view.getZoom() ?? zoom;
  view.cancelAnimations();

  if (Math.abs(startZoom - zoom) < 3) {
    view.animate({ center, duration, easing: inAndOut });
    view.animate(
      { zoom: Math.min(startZoom, zoom) - 1.5, duration: duration / 2, easing: easeOut },
      { zoom, duration: duration / 2, easing: inAndOut },
    );
    return;
  }

  // Long zoom-in: settle on the target early, then zoom in smoothly.
  view.animate({ center, duration: duration * 0.6, easing: easeOut });
  view.animate({ zoom, duration, easing: inAndOut });
}

/** Live location marker: a dot with a pulsing ring (CSS animation). */
function createUserLocationElement() {
  const element = document.createElement("div");
  element.className = "pointer-events-none relative flex h-6 w-6 items-center justify-center";
  element.setAttribute("aria-label", "Your location");

  const ping = document.createElement("span");
  ping.className = "absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500/60";

  const dot = document.createElement("span");
  dot.className =
    "relative inline-flex h-3.5 w-3.5 rounded-full border-2 border-white bg-blue-500 shadow-[0_0_14px_rgba(59,130,246,0.85)]";

  element.append(ping, dot);
  return element;
}

const GeoMap = forwardRef<GeoMapHandle, GeoMapProps>(function GeoMap(
  { theme },
  ref,
) {
  const mapElement = useRef<HTMLDivElement | null>(null);
  const mapInstance = useRef<Map | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>(() =>
    "geolocation" in navigator ? "locating" : "unavailable",
  );
  const [locationStatusVisible, setLocationStatusVisible] = useState(true);

  const baseLayers = useRef<{
    light: TileLayer<XYZ>;
    dark: TileLayer<XYZ>;
  } | null>(null);

  const selectedBaseMap = useRef<"light" | "dark">("dark");
  const baseLayerVisible = useRef(true);
  const markerSourceRef = useRef<VectorSource | null>(null);
  const drawingSourceRef = useRef<VectorSource | null>(null);
  const drawInteractionRef = useRef<Draw | null>(null);
  const selectInteractionRef = useRef<Select | null>(null);
  const pointHighlightLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const spatialQueryHighlightLayerRef =
    useRef<VectorLayer<VectorSource> | null>(null);
  const nearestFeatureLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const nearestOriginLayerRef = useRef<VectorLayer<VectorSource> | null>(null);

  const pickRequestRef = useRef<MapPickRequest | null>(null);
  const pickRestoreCursorRef = useRef("");
  const pickMarkerSourceRef = useRef<VectorSource | null>(null);
  const routeLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  // Latest browser geolocation fix (map projection), if permission was given.
  const userLocationRef = useRef<number[] | null>(null);

  const onFeatureSelectRef = useRef<
    ((feature: SelectedFeatureInfo | null) => void) | null
  >(null);
  interface ImportedLayerRecord {
    id: string;
    name: string;
    source: VectorSource;
    layer: VectorLayer<VectorSource>;
    count: number;
    geometryTypes: string[];
    kind: MapLayerKind;
    color?: string;
    // Features can be clicked and opened in the inspector.
    selectable?: boolean;
  }

  const importedLayersRef = useRef<ImportedLayerRecord[]>([]);

  /** Validate GeoJSON and add it to the shared layer registry (selectable). */
  function registerFeatureLayer(
    collection: GeoJSONFeatureCollection,
    layerName: string,
    options: { kind: MapLayerKind; style: StyleLike; color?: string },
  ): ImportedLayerInfo {
    const map = mapInstance.current;

    if (!map) {
      throw new Error("Map is not ready yet.");
    }

    if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
      throw new Error("The response is not a valid GeoJSON FeatureCollection.");
    }

    const supported = collection.features.filter((feature) =>
      SUPPORTED_GEOMETRY_TYPES.has(feature?.geometry?.type ?? ""),
    );

    if (supported.length === 0) {
      throw new Error("The response contains no supported geometries.");
    }

    const features = new GeoJSON().readFeatures(
      { type: "FeatureCollection", features: supported },
      {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      },
    );

    const source = new VectorSource({ features });
    const layer = new VectorLayer({
      source,
      zIndex: 100 + importedLayersRef.current.length,
      style: options.style,
    });

    const geometryTypes = [
      ...new Set(
        features.map((feature) => feature.getGeometry()?.getType() ?? "Unknown"),
      ),
    ];
    const record: ImportedLayerRecord = {
      id: crypto.randomUUID(),
      name: layerName,
      source,
      layer,
      count: features.length,
      geometryTypes,
      kind: options.kind,
      color: options.color,
      selectable: true,
    };

    map.addLayer(layer);
    importedLayersRef.current.push(record);

    const extent = source.getExtent();

    if (extent && !isEmpty(extent)) {
      map.getView().fit(extent, {
        padding: [80, 80, 80, 80],
        duration: 600,
        maxZoom: 17,
      });
    }

    return {
      id: record.id,
      name: record.name,
      count: record.count,
      geometryTypes,
      visible: true,
      kind: record.kind,
      color: record.color,
    };
  }

  useImperativeHandle(ref, () => ({
    zoomIn() {
      const view = mapInstance.current?.getView();
      if (view) {
        view.animate({
          zoom: (view.getZoom() ?? INITIAL_ZOOM) + 1,
          duration: 200,
        });
      }
    },

    zoomOut() {
      const view = mapInstance.current?.getView();
      if (view) {
        view.animate({
          zoom: (view.getZoom() ?? INITIAL_ZOOM) - 1,
          duration: 200,
        });
      }
    },

    resetView() {
      const view = mapInstance.current?.getView();
      const userLocation = userLocationRef.current;
      if (!view) return;

      if (userLocation) {
        flyTo(view, userLocation, USER_LOCATION_ZOOM, 1200);
      } else {
        view.animate({ center: INITIAL_CENTER, zoom: INITIAL_ZOOM, duration: 300 });
      }
    },

    toggleBaseLayer(visible) {
      const layers = baseLayers.current;
      if (!layers) return;

      baseLayerVisible.current = visible;
      layers.light.setVisible(visible && selectedBaseMap.current === "light");
      layers.dark.setVisible(visible && selectedBaseMap.current === "dark");
    },

    isBaseLayerVisible() {
      return baseLayerVisible.current;
    },

    setBaseMap(type) {
      const layers = baseLayers.current;
      if (!layers || type === "satellite") return;

      selectedBaseMap.current = type;

      layers.light.setVisible(baseLayerVisible.current && type === "light");
      layers.dark.setVisible(baseLayerVisible.current && type === "dark");
    },
    goToLocation(longitude, latitude) {
      const view = mapInstance.current?.getView();
      const markerSource = markerSourceRef.current;

      if (!view || !markerSource) return;

      const coordinate = fromLonLat([longitude, latitude]);

      markerSource.clear();

      markerSource.addFeature(
        new Feature({
          geometry: new Point(coordinate),
        }),
      );

      view.animate({
        center: coordinate,
        zoom: 13,
        duration: 700,
      });
    },
    setDrawingMode(mode) {
      const map = mapInstance.current;
      const source = drawingSourceRef.current;

      if (!map || !source) return;

      if (drawInteractionRef.current) {
        map.removeInteraction(drawInteractionRef.current);
        drawInteractionRef.current = null;
      }

      if (mode === "none") return;

      const draw = new Draw({
        source,
        type: mode,
      });

      map.addInteraction(draw);
      drawInteractionRef.current = draw;
    },

    clearDrawings() {
      drawingSourceRef.current?.clear();
    },
    setOnFeatureSelect(callback) {
      onFeatureSelectRef.current = callback;
    },
    exportDrawings() {
      const source = drawingSourceRef.current;

      if (!source) return '{"type":"FeatureCollection","features":[]}';

      const format = new GeoJSON();

      return format.writeFeatures(source.getFeatures(), {
        featureProjection: "EPSG:3857",
        dataProjection: "EPSG:4326",
        decimals: 6,
      });
    },
    importGeoJSON(content) {
      const map = mapInstance.current;

      if (!map) {
        throw new Error("Map is not ready yet.");
      }

      const format = new GeoJSON();

      // Parse and validate the file before adding a layer.
      const features = format.readFeatures(content, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });

      if (features.length === 0) {
        throw new Error("The file contains no supported geographic features.");
      }

      const supportedTypes = new Set([
        "Point",
        "MultiPoint",
        "LineString",
        "MultiLineString",
        "Polygon",
        "MultiPolygon",
      ]);

      if (
        features.some((feature) => {
          const geometry = feature.getGeometry();
          return !geometry || !supportedTypes.has(geometry.getType());
        })
      ) {
        throw new Error("The file contains an unsupported geometry type.");
      }

      const geometryTypes = [
        ...new Set(
          features.map(
            (feature) => feature.getGeometry()?.getType() ?? "Unknown",
          ),
        ),
      ];

      const id = crypto.randomUUID();
      const name = `Imported Layer ${importedLayersRef.current.length + 1}`;
      const source = new VectorSource({ features });

      const layer = new VectorLayer({
        source,
        zIndex: 80 + importedLayersRef.current.length,
        style: new Style({
          fill: new Fill({
            color: "rgba(59, 130, 246, 0.18)",
          }),
          stroke: new Stroke({
            color: "#3b82f6",
            width: 2,
          }),
          image: new Circle({
            radius: 6,
            fill: new Fill({ color: "#3b82f6" }),
            stroke: new Stroke({
              color: "#ffffff",
              width: 2,
            }),
          }),
        }),
      });

      map.addLayer(layer);

      importedLayersRef.current.push({
        id,
        name,
        source,
        layer,
        count: features.length,
        geometryTypes,
        kind: "imported",
      });

      return {
        count: features.length,
        geometryTypes,
      };
    },

    getImportedLayers() {
      return importedLayersRef.current.map(
        ({ id, name, count, geometryTypes, layer, kind, color }) => ({
          id,
          name,
          count,
          geometryTypes,
          visible: layer.getVisible(),
          kind,
          color,
        }),
      );
    },

    setImportedLayerVisibility(id, visible) {
      const record = importedLayersRef.current.find((item) => item.id === id);
      record?.layer.setVisible(visible);
    },

    removeImportedLayer(id) {
      const map = mapInstance.current;
      const record = importedLayersRef.current.find((item) => item.id === id);

      if (!map || !record) return;

      const selected = selectInteractionRef.current?.getFeatures();

      if (selected?.getArray().some((feature) => record.source.hasFeature(feature))) {
        selected.clear();
        onFeatureSelectRef.current?.(null);
      }

      map.removeLayer(record.layer);
      importedLayersRef.current = importedLayersRef.current.filter(
        (item) => item.id !== id,
      );
    },

    clearImportedData() {
      const map = mapInstance.current;

      if (!map) return;

      importedLayersRef.current.forEach(({ layer }) => {
        map.removeLayer(layer);
      });

      importedLayersRef.current = [];
    },
    zoomToImportedLayer(id) {
      const map = mapInstance.current;

      if (!map) return;

      const record = importedLayersRef.current.find((item) => item.id === id);

      if (!record) return;

      const extent = record.source.getExtent();

      if (!extent || isEmpty(extent)) return;

      map.getView().fit(extent, {
        padding: [60, 60, 60, 60],
        duration: 500,
        maxZoom: 16,
      });
    },
    addBufferGeoJSON(geojson) {
      const map = mapInstance.current;

      if (!map) {
        throw new Error("Map is not ready yet.");
      }

      const format = new GeoJSON();

      const features = format.readFeatures(geojson, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });

      if (features.length === 0) {
        throw new Error("The buffer response contains no features.");
      }

      const source = new VectorSource({ features });

      const layer = new VectorLayer({
        source,
        zIndex: 95,
        style: new Style({
          fill: new Fill({
            color: "rgba(16, 185, 129, 0.20)",
          }),
          stroke: new Stroke({
            color: "#10b981",
            width: 3,
          }),
        }),
      });

      map.addLayer(layer);

      const extent = source.getExtent();

      if (extent && !isEmpty(extent)) {
        map.getView().fit(extent, {
          padding: [60, 60, 60, 60],
          duration: 500,
          maxZoom: 16,
        });
      }
    },
    clearFeatureSelection() {
      selectInteractionRef.current?.getFeatures().clear();
      onFeatureSelectRef.current?.(null);
    },
    getImportedPoints() {
      return importedLayersRef.current
        .filter(({ layer }) => layer.getVisible())
        .map(({ id, name, source }) => {
          const points = source.getFeatures().flatMap((feature) => {
            const geometry = feature.getGeometry();

            if (!geometry || geometry.getType() !== "Point") {
              return [];
            }

            const point = geometry as Point;

            const coordinates = point
              .clone()
              .transform("EPSG:3857", "EPSG:4326")
              .getCoordinates();

            return [
              {
                coordinates: [coordinates[0], coordinates[1]] as [
                  number,
                  number,
                ],
                featureId: String(feature.getId() ?? crypto.randomUUID()),
              },
            ];
          });

          return {
            layerId: id,
            layerName: name,
            points,
          };
        });
    },
    highlightPointsInPolygon(coordinates) {
      const map = mapInstance.current;

      if (!map) return;

      // Remove highlights from the previous analysis.
      if (pointHighlightLayerRef.current) {
        map.removeLayer(pointHighlightLayerRef.current);
        pointHighlightLayerRef.current = null;
      }

      if (coordinates.length === 0) return;

      const features = coordinates.map(
        ([longitude, latitude]) =>
          new Feature({
            geometry: new Point(fromLonLat([longitude, latitude])),
          }),
      );

      const source = new VectorSource({ features });

      const layer = new VectorLayer({
        source,
        zIndex: 110,
        style: new Style({
          image: new Circle({
            radius: 8,
            fill: new Fill({ color: "#10b981" }),
            stroke: new Stroke({
              color: "#ffffff",
              width: 2,
            }),
          }),
        }),
      });

      map.addLayer(layer);
      pointHighlightLayerRef.current = layer;
    },

    clearPointHighlights() {
      const map = mapInstance.current;
      const layer = pointHighlightLayerRef.current;

      if (map && layer) {
        map.removeLayer(layer);
        pointHighlightLayerRef.current = null;
      }
    },
    getImportedGeoJSON(layerId) {
      const record = importedLayersRef.current.find(
        (item) => item.id === layerId,
      );

      if (!record) return null;

      return new GeoJSON().writeFeatures(record.source.getFeatures(), {
        featureProjection: "EPSG:3857",
        dataProjection: "EPSG:4326",
        decimals: 6,
      });
    },
    highlightSpatialQueryResults(features) {
      const map = mapInstance.current;

      if (!map) return;

      // Remove only the previous spatial-query highlight layer.
      if (spatialQueryHighlightLayerRef.current) {
        map.removeLayer(spatialQueryHighlightLayerRef.current);
        spatialQueryHighlightLayerRef.current = null;
      }

      if (features.length === 0) return;

      const format = new GeoJSON();

      const mapFeatures = format.readFeatures(
        {
          type: "FeatureCollection",
          features,
        },
        {
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857",
        },
      );

      const source = new VectorSource({
        features: mapFeatures,
      });

      const layer = new VectorLayer({
        source,
        zIndex: 115,
        style: new Style({
          fill: new Fill({
            color: "rgba(16, 185, 129, 0.22)",
          }),
          stroke: new Stroke({
            color: "#10b981",
            width: 4,
          }),
          image: new Circle({
            radius: 9,
            fill: new Fill({
              color: "#10b981",
            }),
            stroke: new Stroke({
              color: "#ffffff",
              width: 2,
            }),
          }),
        }),
      });

      map.addLayer(layer);
      spatialQueryHighlightLayerRef.current = layer;

      const extent = source.getExtent();

      if (extent && !isEmpty(extent)) {
        map.getView().fit(extent, {
          padding: [80, 80, 80, 80],
          duration: 500,
          maxZoom: 16,
        });
      }
    },

    addClipResultGeoJSON(geojson, layerName) {
      const map = mapInstance.current;

      if (!map) {
        throw new Error("Map is not ready yet.");
      }

      const format = new GeoJSON();

      const features = format.readFeatures(geojson, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });

      if (features.length === 0) {
        throw new Error("The clip result contains no features.");
      }

      const source = new VectorSource({ features });

      const layer = new VectorLayer({
        source,
        zIndex: 100 + importedLayersRef.current.length,
        style: new Style({
          fill: new Fill({
            color: "rgba(16, 185, 129, 0.24)",
          }),
          stroke: new Stroke({
            color: "#10b981",
            width: 3,
          }),
          image: new Circle({
            radius: 7,
            fill: new Fill({ color: "#10b981" }),
            stroke: new Stroke({
              color: "#ffffff",
              width: 2,
            }),
          }),
        }),
      });

      const geometryTypes = [
        ...new Set(
          features.map(
            (feature) => feature.getGeometry()?.getType() ?? "Unknown",
          ),
        ),
      ];

      const id = crypto.randomUUID();
      const name = `${layerName ?? "Clip Result"} ${
        importedLayersRef.current.length + 1
      }`;

      map.addLayer(layer);

      importedLayersRef.current.push({
        id,
        name,
        source,
        layer,
        count: features.length,
        geometryTypes,
        kind: "analysis",
      });

      const extent = source.getExtent();

      if (extent && !isEmpty(extent)) {
        map.getView().fit(extent, {
          padding: [60, 60, 60, 60],
          duration: 500,
          maxZoom: 16,
        });
      }

      return id;
    },
    fitToGeoJSON(items) {
      const map = mapInstance.current;

      if (!map || items.length === 0) return;

      const format = new GeoJSON();
      const features = items.flatMap((item) =>
        item.type === "Feature"
          ? format.readFeatures(item, {
              dataProjection: "EPSG:4326",
              featureProjection: "EPSG:3857",
            })
          : [
              new Feature(
                format.readGeometry(item, {
                  dataProjection: "EPSG:4326",
                  featureProjection: "EPSG:3857",
                }) ?? undefined,
              ),
            ],
      );
      const extent = new VectorSource({ features }).getExtent();

      if (!extent || isEmpty(extent)) return;

      map.getView().fit(extent, {
        padding: [80, 80, 80, 80],
        duration: 500,
        maxZoom: 17,
      });
    },
    startMapPick(request) {
      const map = mapInstance.current;

      if (!map) return;

      if (!pickRequestRef.current) {
        pickRestoreCursorRef.current = map.getViewport()?.style.cursor ?? "";
      }

      pickRequestRef.current = request;
      setViewportCursor(map, "crosshair");
      // Pause feature selection so a pick click does not also select.
      selectInteractionRef.current?.setActive(false);
    },
    cancelMapPick() {
      const map = mapInstance.current;

      if (!pickRequestRef.current) return;

      pickRequestRef.current = null;
      selectInteractionRef.current?.setActive(true);

      if (map) {
        setViewportCursor(map, pickRestoreCursorRef.current);
      }
    },
    setPickMarker(key, role, coordinates) {
      const source = pickMarkerSourceRef.current;

      if (!source) return;

      const existing = source.getFeatureById(key);

      if (existing) source.removeFeature(existing);

      if (!coordinates) return;

      const marker = new Feature({ geometry: new Point(fromLonLat(coordinates)) });
      marker.setId(key);
      marker.setStyle(pickMarkerStyle(role));
      source.addFeature(marker);
    },

    highlightNearestFeature(origin, feature) {
      const map = mapInstance.current;
      if (!map) return;

      // Clear previous nearest-feature highlights.
      if (nearestFeatureLayerRef.current) {
        map.removeLayer(nearestFeatureLayerRef.current);
        nearestFeatureLayerRef.current = null;
      }

      if (nearestOriginLayerRef.current) {
        map.removeLayer(nearestOriginLayerRef.current);
        nearestOriginLayerRef.current = null;
      }

      const format = new GeoJSON();

      const nearestFeatures = format.readFeatures(
        {
          type: "FeatureCollection",
          features: [feature],
        },
        {
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857",
        },
      );

      if (nearestFeatures.length === 0) {
        throw new Error("The nearest feature could not be displayed.");
      }

      const nearestSource = new VectorSource({
        features: nearestFeatures,
      });

      const nearestLayer = new VectorLayer({
        source: nearestSource,
        zIndex: 120,
        style: new Style({
          fill: new Fill({ color: "rgba(16, 185, 129, 0.25)" }),
          stroke: new Stroke({ color: "#10b981", width: 4 }),
          image: new Circle({
            radius: 10,
            fill: new Fill({ color: "#10b981" }),
            stroke: new Stroke({ color: "#ffffff", width: 2 }),
          }),
        }),
      });

      const originSource = new VectorSource({
        features: [
          new Feature({
            geometry: new Point(fromLonLat(origin)),
          }),
        ],
      });

      const originLayer = new VectorLayer({
        source: originSource,
        zIndex: 121,
        style: new Style({
          image: new Circle({
            radius: 8,
            fill: new Fill({ color: "#f59e0b" }),
            stroke: new Stroke({ color: "#ffffff", width: 2 }),
          }),
        }),
      });

      map.addLayer(nearestLayer);
      map.addLayer(originLayer);

      nearestFeatureLayerRef.current = nearestLayer;
      nearestOriginLayerRef.current = originLayer;

      const extent = nearestSource.getExtent();

      if (extent && !isEmpty(extent)) {
        map.getView().fit(extent, {
          padding: [80, 80, 80, 80],
          duration: 500,
          maxZoom: 16,
        });
      }
    },

    clearNearestFeatureHighlight() {
      const map = mapInstance.current;

      if (nearestFeatureLayerRef.current) {
        map?.removeLayer(nearestFeatureLayerRef.current);
        nearestFeatureLayerRef.current = null;
      }

      if (nearestOriginLayerRef.current) {
        map?.removeLayer(nearestOriginLayerRef.current);
        nearestOriginLayerRef.current = null;
      }
    },
    highlightNearestFeatures(origin, features) {
      const map = mapInstance.current;
      if (!map) return;

      if (nearestFeatureLayerRef.current) {
        map.removeLayer(nearestFeatureLayerRef.current);
        nearestFeatureLayerRef.current = null;
      }

      if (nearestOriginLayerRef.current) {
        map.removeLayer(nearestOriginLayerRef.current);
        nearestOriginLayerRef.current = null;
      }

      const format = new GeoJSON();

      const mapFeatures = format.readFeatures(
        {
          type: "FeatureCollection",
          features,
        },
        {
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857",
        },
      );

      mapFeatures.forEach((feature, index) => {
        feature.set("nearestRank", index + 1);
      });

      const nearestSource = new VectorSource({
        features: mapFeatures,
      });

      const nearestLayer = new VectorLayer({
        source: nearestSource,
        zIndex: 120,
        style: (feature) => {
          const rank = Number(feature.get("nearestRank"));
          const isNearest = rank === 1;

          return new Style({
            fill: new Fill({
              color: isNearest
                ? "rgba(167, 139, 250, 0.16)"
                : "rgba(251, 113, 133, 0.07)",
            }),
            stroke: new Stroke({
              color: isNearest ? "#a78bfa" : "#fb7185",
              width: isNearest ? 3 : 2,
            }),
            image: new Circle({
              radius: isNearest ? 9 : 7,
              fill: new Fill({
                color: isNearest ? "#a78bfa" : "#fb7185",
              }),
              stroke: new Stroke({
                color: "#ffffff",
                width: 2,
              }),
            }),
          });
        },
      });

      const originSource = new VectorSource({
        features: [
          new Feature({
            geometry: new Point(fromLonLat(origin)),
          }),
        ],
      });

      const originLayer = new VectorLayer({
        source: originSource,
        zIndex: 121,
        style: new Style({
          image: new Circle({
            radius: 8,
            fill: new Fill({ color: "#f59e0b" }),
            stroke: new Stroke({ color: "#ffffff", width: 2 }),
          }),
        }),
      });

      map.addLayer(nearestLayer);
      map.addLayer(originLayer);

      nearestFeatureLayerRef.current = nearestLayer;
      nearestOriginLayerRef.current = originLayer;

      const extent = nearestSource.getExtent();

      if (extent && !isEmpty(extent)) {
        map.getView().fit(extent, {
          padding: [80, 80, 80, 80],
          duration: 500,
          maxZoom: 16,
        });
      }
    },
    setHeatmap(layerId, radius, blur) {
      const map = mapInstance.current;

      if (!map) {
        throw new Error("Map is not ready yet.");
      }

      // Disable and remove the existing heatmap.
      const existingHeatmap = map
        .getLayers()
        .getArray()
        .find((layer) => layer.get("name") === "geomind-heatmap");

      if (existingHeatmap) {
        map.removeLayer(existingHeatmap);
      }

      // Null layerId means disable the heatmap.
      if (!layerId) return;

      const importedLayer = importedLayersRef.current.find(
        (item) => item.id === layerId,
      );

      if (!importedLayer) {
        throw new Error("Please select a valid imported layer.");
      }

      const pointFeatures = importedLayer.source
        .getFeatures()
        .filter((feature) => {
          const geometry = feature.getGeometry();
          return (
            geometry?.getType() === "Point" ||
            geometry?.getType() === "MultiPoint"
          );
        });

      if (pointFeatures.length === 0) {
        throw new Error(
          "The selected layer contains no point features for heatmap analysis.",
        );
      }

      const heatmapLayer = new HeatmapLayer({
        source: new VectorSource({
          features: pointFeatures,
        }),
        blur: Math.max(0, blur),
        radius: Math.max(1, radius),
        weight: () => 1,
        opacity: 0.8,
        zIndex: 1000,
      });

      heatmapLayer.set("name", "geomind-heatmap");
      map.addLayer(heatmapLayer);
    },

    showRouteDistance(start, destination) {
      const map = mapInstance.current;

      if (!map) {
        throw new Error("Map is not ready yet.");
      }

      if (routeLayerRef.current) {
        map.removeLayer(routeLayerRef.current);
        routeLayerRef.current = null;
      }

      const startCoordinate = fromLonLat(start);
      const destinationCoordinate = fromLonLat(destination);

      const source = new VectorSource({
        features: [
          new Feature({
            geometry: new LineString([startCoordinate, destinationCoordinate]),
          }),
          new Feature({
            geometry: new Point(startCoordinate),
            routePoint: "start",
          }),
          new Feature({
            geometry: new Point(destinationCoordinate),
            routePoint: "destination",
          }),
        ],
      });

      const layer = new VectorLayer({
        source,
        zIndex: 125,
        style: (feature) => {
          if (feature.get("routePoint")) {
            return new Style({
              image: new Circle({
                radius: 8,
                fill: new Fill({
                  color:
                    feature.get("routePoint") === "start"
                      ? "#f59e0b"
                      : "#a78bfa",
                }),
                stroke: new Stroke({
                  color: "#ffffff",
                  width: 2,
                }),
              }),
            });
          }

          return new Style({
            stroke: new Stroke({
              color: "#a78bfa",
              width: 3,
              lineDash: [8, 5],
            }),
          });
        },
      });

      map.addLayer(layer);
      routeLayerRef.current = layer;

      return getDistance(start, destination);
    },

    clearRouteDistance() {
      const map = mapInstance.current;

      if (map && routeLayerRef.current) {
        map.removeLayer(routeLayerRef.current);
        routeLayerRef.current = null;
      }
    },

showRoadRoute(geometry) {
  const map = mapInstance.current;

  if (!map) {
    throw new Error("Map is not ready yet.");
  }

  if (
    geometry.type !== "LineString" ||
    geometry.coordinates.length < 2
  ) {
    throw new Error("The road route geometry is invalid.");
  }

  if (routeLayerRef.current) {
    map.removeLayer(routeLayerRef.current);
    routeLayerRef.current = null;
  }

  const routeCoordinates = geometry.coordinates.map(
    ([longitude, latitude]) => fromLonLat([longitude, latitude]),
  );

  const source = new VectorSource({
    features: [
      new Feature({
        geometry: new LineString(routeCoordinates),
        routePoint: "road",
      }),
      new Feature({
        geometry: new Point(routeCoordinates[0]),
        routePoint: "start",
      }),
      new Feature({
        geometry: new Point(routeCoordinates[routeCoordinates.length - 1]),
        routePoint: "destination",
      }),
    ],
  });

  const layer = new VectorLayer({
    source,
    zIndex: 125,
    style: (feature) => {
      const pointType = feature.get("routePoint");

      if (pointType === "start") {
        return new Style({
          image: new Circle({
            radius: 8,
            fill: new Fill({ color: "#f59e0b" }),
            stroke: new Stroke({ color: "#ffffff", width: 2 }),
          }),
        });
      }

      if (pointType === "destination") {
        return new Style({
          image: new Circle({
            radius: 8,
            fill: new Fill({ color: "#a78bfa" }),
            stroke: new Stroke({ color: "#ffffff", width: 2 }),
          }),
        });
      }

      return new Style({
        stroke: new Stroke({
          color: "#a78bfa",
          width: 5,
        }),
      });
    },
  });

  map.addLayer(layer);
  routeLayerRef.current = layer;

  const extent = source.getExtent();

  if (!extent) return;

  map.getView().fit(extent, {
    padding: [100, 100, 100, 100],
    duration: 600,
    maxZoom: 17,
  });
},
getNearestFeaturesInput() {
  const map = mapInstance.current;

  if (!map) return null;

  const center = map.getView().getCenter();

  if (!center || importedLayersRef.current.length === 0) {
    return null;
  }

  const format = new GeoJSON();

  const features = importedLayersRef.current.flatMap(
    ({ source, layer }) => {
      if (!layer.getVisible()) return [];

      return format.writeFeaturesObject(source.getFeatures(), {
        featureProjection: "EPSG:3857",
        dataProjection: "EPSG:4326",
      }).features;
    },
  );

  if (features.length === 0) return null;

  const [longitude, latitude] = transform(
    center,
    "EPSG:3857",
    "EPSG:4326",
  );

  return {
    coordinates: [longitude, latitude] as [number, number],
    features: features as unknown as Record<string, unknown>[],
  };
},

getViewCenter() {
  const center = mapInstance.current?.getView().getCenter();

  if (!center) return null;

  const [longitude, latitude] = toLonLat(center);
  return [longitude, latitude];
},
addDiscoveryLayer(collection, layerName) {
  const discoveryCount = importedLayersRef.current.filter(
    (record) => record.kind === "discovery",
  ).length;
  const color = DISCOVERY_COLORS[discoveryCount % DISCOVERY_COLORS.length];

  return registerFeatureLayer(collection, layerName, {
    kind: "discovery",
    color,
    style: discoveryStyle(color),
  });
},
addClassifiedLayer(collection, layerName, property, palette, outline) {
  const fallback = "#737373";
  // One cached style per class ("Map" here is the OpenLayers map class).
  const styles: Record<string, Style> = {};
  const styleFor = (value: unknown) => {
    const key = String(value);
    styles[key] ??= classifiedStyle(palette[key] ?? fallback, outline);
    return styles[key];
  };

  return registerFeatureLayer(collection, layerName, {
    kind: "analysis",
    color: outline,
    style: (feature) => styleFor(feature.get(property)),
  });
},
clearDiscoveryLayers() {
  importedLayersRef.current
    .filter((record) => record.kind === "discovery")
    .forEach((record) => this.removeImportedLayer(record.id));
},

  }));

  useEffect(() => {
    const layers = baseLayers.current;

    if (!layers) return;

    layers.light.setVisible(theme === "light");
    layers.dark.setVisible(theme === "dark");
  }, [theme]);

  useEffect(() => {
    if (!mapElement.current || mapInstance.current) return;

    const cartoKey = import.meta.env.VITE_CARTO_API_KEY;

    const lightLayer = new TileLayer({
      source: new XYZ({
        url: `https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key=${cartoKey}`,
        attributions: "&copy; OpenStreetMap contributors &copy; CARTO",
      }),
      visible: theme === "light",
    });

    const darkLayer = new TileLayer({
      source: new XYZ({
        url: `https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=${cartoKey}`,
        attributions: "&copy; OpenStreetMap contributors &copy; CARTO",
      }),
      visible: theme === "dark",
    });

    const markerSource = new VectorSource();
    markerSourceRef.current = markerSource;

    const markerLayer = new VectorLayer({
      source: markerSource,
      zIndex: 100,
      style: new Style({
        image: new Circle({
          radius: 8,
          fill: new Fill({ color: "#10b981" }),
          stroke: new Stroke({
            color: "#ffffff",
            width: 2,
          }),
        }),
      }),
    });
    const drawingSource = new VectorSource();
    drawingSourceRef.current = drawingSource;

    const drawingLayer = new VectorLayer({
      source: drawingSource,
      zIndex: 90,
      style: new Style({
        fill: new Fill({
          color: "rgba(16, 185, 129, 0.18)",
        }),
        stroke: new Stroke({
          color: "#10b981",
          width: 3,
        }),
        image: new Circle({
          radius: 6,
          fill: new Fill({ color: "#10b981" }),
          stroke: new Stroke({ color: "#ffffff", width: 2 }),
        }),
      }),
    });

    const pickMarkerSource = new VectorSource();
    pickMarkerSourceRef.current = pickMarkerSource;

    const pickMarkerLayer = new VectorLayer({
      source: pickMarkerSource,
      zIndex: 1100,
    });

    baseLayers.current = {
      light: lightLayer,
      dark: darkLayer,
    };

    // Live location: accuracy circle (vector) plus a pulsing dot (overlay).
    const userLocationSource = new VectorSource();
    const userLocationLayer = new VectorLayer({
      source: userLocationSource,
      zIndex: 95,
      style: new Style({
        fill: new Fill({ color: "rgba(59, 130, 246, 0.12)" }),
        stroke: new Stroke({ color: "rgba(59, 130, 246, 0.45)", width: 1 }),
      }),
    });
    const userLocationOverlay = new Overlay({
      element: createUserLocationElement(),
      positioning: "center-center",
      stopEvent: false,
    });

    const map = new Map({
      target: mapElement.current,
      layers: [lightLayer, darkLayer, drawingLayer, userLocationLayer, markerLayer, pickMarkerLayer],
      view: new View({
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
      }),
    });

    mapInstance.current = map;
    map.addOverlay(userLocationOverlay);

    // Start at the user's live location when the browser allows it; without
    // permission (or on failure) the world view stays.
    let centredOnUser = false;
    const watchId =
      "geolocation" in navigator
        ? navigator.geolocation.watchPosition(
            ({ coords }) => {
              const lonLat = [coords.longitude, coords.latitude];
              const coordinate = fromLonLat(lonLat);
              userLocationRef.current = coordinate;
              userLocationSource.clear();
              userLocationSource.addFeature(
                new Feature({
                  geometry: circular(lonLat, Math.max(coords.accuracy, 1), 64).transform(
                    "EPSG:4326",
                    "EPSG:3857",
                  ),
                }),
              );
              userLocationOverlay.setPosition(coordinate);

              if (centredOnUser) return;
              centredOnUser = true;
              setLocationStatus("found");

              // Fly in once, and only if the user has not zoomed in already.
              const zoom = map.getView().getZoom() ?? INITIAL_ZOOM;
              if (zoom < INITIAL_ZOOM + 0.5) {
                flyTo(map.getView(), coordinate, USER_LOCATION_ZOOM);
              }
            },
            (error) => {
              // Later watch errors keep the last known position.
              if (!centredOnUser) {
                setLocationStatus(error.code === error.PERMISSION_DENIED ? "denied" : "unavailable");
              }
            },
            { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 },
          )
        : null;

    map.on("singleclick", (event) => {
      const [longitude, latitude] = toLonLat(event.coordinate);
      const coordinates: [number, number] = [longitude, latitude];

      const request = pickRequestRef.current;

      if (!request) return;

      if (request.mode === "point") {
        finishPick();
        request.onPick(coordinates);
        return;
      }

      let picked: Feature | undefined;

      map.forEachFeatureAtPixel(
        event.pixel,
        (feature) => {
          const type = feature.getGeometry()?.getType() ?? "";

          if (request.geometryTypes && !request.geometryTypes.includes(type)) {
            return undefined;
          }

          picked = feature as Feature;
          return true;
        },
        {
          hitTolerance: 4,
          layerFilter: (layer) =>
            layer === drawingLayer ||
            importedLayersRef.current.some((record) => record.layer === layer),
        },
      );

      // Clicking empty map keeps feature-pick mode active.
      if (!picked) return;

      const geojson = new GeoJSON().writeFeatureObject(picked, {
        featureProjection: "EPSG:3857",
        dataProjection: "EPSG:4326",
      });

      finishPick();
      request.onPick(geojson);
    });

    function finishPick() {
      pickRequestRef.current = null;
      selectInteractionRef.current?.setActive(true);
      setViewportCursor(map, pickRestoreCursorRef.current);
    }

    const selectInteraction = new Select({
      condition: click,
      layers: (layer) =>
        layer === drawingLayer ||
        importedLayersRef.current.some(
          (record) => record.selectable && record.layer === layer,
        ),
      style: new Style({
        fill: new Fill({
          color: "rgba(16, 185, 129, 0.3)",
        }),
        stroke: new Stroke({
          color: "#34d399",
          width: 4,
        }),
        image: new Circle({
          radius: 9,
          fill: new Fill({ color: "#10b981" }),
          stroke: new Stroke({ color: "#ffffff", width: 2 }),
        }),
      }),
    });

    map.addInteraction(selectInteraction);
    selectInteractionRef.current = selectInteraction;

    selectInteraction.on("select", (event) => {
      const feature = event.selected[0];

      if (!feature) {
        onFeatureSelectRef.current?.(null);
        return;
      }

      const geometry = feature.getGeometry();

      if (!geometry) return;

      const geometryType = geometry.getType();

      if (!SUPPORTED_GEOMETRY_TYPES.has(geometryType)) {
        return;
      }

      let lengthMeters: number | undefined;
      let areaSquareMeters: number | undefined;
      let perimeterMeters: number | undefined;

      if (geometryType === "LineString" || geometryType === "MultiLineString") {
        lengthMeters = getLength(geometry);
      }

      if (geometryType === "Polygon" || geometryType === "MultiPolygon") {
        areaSquareMeters = getArea(geometry);
        perimeterMeters = getLength(geometry);
      }

      const simpleGeometry = geometry as SimpleGeometry;
      const coordinates = simpleGeometry.getCoordinates();
      const coordinatesWGS84 = (simpleGeometry.clone() as SimpleGeometry)
        .transform("EPSG:3857", "EPSG:4326")
        .getCoordinates();

      // getProperties() returns OpenLayers' internal object, so copy it.
      const featureProperties = { ...feature.getProperties() };
      delete featureProperties[feature.getGeometryName()];

      onFeatureSelectRef.current?.({
        id: String(feature.getId() ?? crypto.randomUUID()),
        geometryType,
        coordinates,
        coordinatesWGS84,
        lengthMeters,
        areaSquareMeters,
        perimeterMeters,
        properties:
          Object.keys(featureProperties).length > 0
            ? featureProperties
            : undefined,
      });
    });
    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      map.removeOverlay(userLocationOverlay);

      if (drawInteractionRef.current) {
        map.removeInteraction(drawInteractionRef.current);
      }

      if (selectInteractionRef.current) {
        map.removeInteraction(selectInteractionRef.current);
      }

      drawInteractionRef.current = null;
      selectInteractionRef.current = null;

      map.setTarget(undefined);

      mapInstance.current = null;
      baseLayers.current = null;
      markerSourceRef.current = null;
      drawingSourceRef.current = null;
      importedLayersRef.current = [];
      pickRequestRef.current = null;
      pickMarkerSourceRef.current = null;
      nearestFeatureLayerRef.current = null;
      nearestOriginLayerRef.current = null;
      routeLayerRef.current = null;
      userLocationRef.current = null;
    };
  }, []);

  // Fade the location status out once it has been read.
  useEffect(() => {
    if (locationStatus === "locating") return;
    const timer = window.setTimeout(
      () => setLocationStatusVisible(false),
      locationStatus === "found" ? 2500 : 6000,
    );
    return () => window.clearTimeout(timer);
  }, [locationStatus]);

  const isDark = theme === "dark";
  const StatusIcon =
    locationStatus === "locating" ? LoaderCircle : locationStatus === "found" ? LocateFixed : MapPinOff;

  return (
    <div className="relative h-full w-full">
      <div ref={mapElement} className="h-full w-full" />
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-none absolute bottom-24 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium shadow-lg backdrop-blur-xl transition-all duration-500 ease-out ${
          locationStatusVisible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
        } ${
          isDark
            ? "border-white/10 bg-neutral-950/80 text-neutral-100"
            : "border-gray-200/80 bg-white/90 text-gray-900"
        }`}
      >
        <StatusIcon
          size={14}
          className={`shrink-0 ${
            locationStatus === "locating"
              ? "animate-spin text-sky-500"
              : locationStatus === "found"
                ? "text-blue-500"
                : "text-amber-500"
          }`}
        />
        {LOCATION_MESSAGES[locationStatus]}
      </div>
    </div>
  );
});

export default GeoMap;
