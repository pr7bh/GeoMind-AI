import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import "ol/ol.css";
import { fromLonLat } from "ol/proj";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import Draw from "ol/interaction/Draw";
import type { DrawingMode } from "./DrawingToolbar";
import Select from "ol/interaction/Select";
import { click } from "ol/events/condition";
import LineString from "ol/geom/LineString";
import Polygon from "ol/geom/Polygon";
import { getArea, getLength } from "ol/sphere";
import GeoJSON from "ol/format/GeoJSON";
import { isEmpty } from "ol/extent";

export interface SelectedFeatureInfo {
  id: string;
  geometryType: string;
  coordinates: unknown;
  coordinatesWGS84: unknown;
  lengthMeters?: number;
  areaSquareMeters?: number;
  perimeterMeters?: number;
}

export interface ImportedLayerInfo {
  id: string;
  name: string;
  count: number;
  geometryTypes: string[];
  visible: boolean;
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
}

const INITIAL_CENTER: [number, number] = [0, 0];
const INITIAL_ZOOM = 2;

const GeoMap = forwardRef<GeoMapHandle>(function GeoMap(_, ref) {
  const mapElement = useRef<HTMLDivElement | null>(null);
  const mapInstance = useRef<Map | null>(null);

  const baseLayers = useRef<{
    light: TileLayer<OSM>;
    dark: TileLayer<XYZ>;
  } | null>(null);

  const selectedBaseMap = useRef<"light" | "dark">("dark");
  const baseLayerVisible = useRef(true);
  const markerSourceRef = useRef<VectorSource | null>(null);
  const drawingSourceRef = useRef<VectorSource | null>(null);
  const drawInteractionRef = useRef<Draw | null>(null);
  const selectInteractionRef = useRef<Select | null>(null);

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
  }

  const importedLayersRef = useRef<ImportedLayerRecord[]>([]);

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
      mapInstance.current?.getView().animate({
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
        duration: 300,
      });
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
      });

      return {
        count: features.length,
        geometryTypes,
      };
    },

    getImportedLayers() {
      return importedLayersRef.current.map(
        ({ id, name, count, geometryTypes, layer }) => ({
          id,
          name,
          count,
          geometryTypes,
          visible: layer.getVisible(),
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

      if (isEmpty(extent)) return;

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

      if (!isEmpty(extent)) {
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
    
  }));

  useEffect(() => {
    if (!mapElement.current || mapInstance.current) return;

    const lightLayer = new TileLayer({
      source: new OSM(),
      visible: false,
    });

    const darkLayer = new TileLayer({
      source: new OSM(),
      visible: true,
      className: "geomind-dark-tiles",
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

    baseLayers.current = {
      light: lightLayer,
      dark: darkLayer,
    };

    const map = new Map({
      target: mapElement.current,
      layers: [lightLayer, darkLayer, drawingLayer, markerLayer],
      view: new View({
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
      }),
    });

    mapInstance.current = map;

    const selectInteraction = new Select({
      condition: click,
      layers: [drawingLayer],
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

      let lengthMeters: number | undefined;
      let areaSquareMeters: number | undefined;
      let perimeterMeters: number | undefined;

      if (geometryType === "LineString") {
        lengthMeters = getLength(geometry as LineString);
      }

      if (geometryType === "Polygon") {
        const polygon = geometry as Polygon;

        areaSquareMeters = getArea(polygon);
        perimeterMeters = getLength(polygon);
      }

      const coordinatesWGS84 = geometry
        .clone()
        .transform("EPSG:3857", "EPSG:4326")
        .getCoordinates();

      onFeatureSelectRef.current?.({
        id: String(feature.getId() ?? feature.ol_uid),
        geometryType,
        coordinates: geometry.getCoordinates(),
        coordinatesWGS84,
        lengthMeters,
        areaSquareMeters,
        perimeterMeters,
      });
    });
    return () => {
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
    };
  }, []);

  return <div ref={mapElement} className="h-full w-full" />;
});

export default GeoMap;
