import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Feature as GeoJSONFeature } from "geojson";
import type { GeoMapHandle, PickMarkerRole } from "../workspace/GeoMap";
import type { DrawingMode } from "../workspace/DrawingToolbar";

export type PickOwner =
  | "discovery"
  | "routing"
  | "nearest"
  | "buffer"
  | "spatial-query";

export type PickTarget =
  | "location"
  | "start"
  | "destination"
  | "reference"
  | "center"
  | "polygon";

export interface ActivePick {
  owner: PickOwner;
  target: PickTarget;
  instruction: string;
}

export interface MapPicker {
  active: ActivePick | null;
  isPicking: (owner: PickOwner, target?: PickTarget) => boolean;
  pickPoint: (
    owner: PickOwner,
    target: PickTarget,
    instruction: string,
    onPick: (coordinates: [number, number]) => void,
  ) => void;
  pickFeature: (
    owner: PickOwner,
    target: PickTarget,
    instruction: string,
    geometryTypes: string[],
    onPick: (feature: GeoJSONFeature) => void,
  ) => void;
  /** Cancels the active pick; with an owner, only that owner's pick. */
  cancel: (owner?: PickOwner) => void;
  setMarker: (
    owner: PickOwner,
    target: PickTarget,
    coordinates: [number, number] | null,
  ) => void;
}

const MARKER_ROLES: Record<PickTarget, PickMarkerRole> = {
  start: "start",
  destination: "destination",
  reference: "reference",
  location: "location",
  center: "location",
  polygon: "location",
};

interface DrawingControl {
  mode: DrawingMode;
  setMode: (mode: DrawingMode) => void;
}

export function useMapPicker(
  mapRef: RefObject<GeoMapHandle | null>,
  drawing: DrawingControl,
): MapPicker {
  const [active, setActive] = useState<ActivePick | null>(null);
  const activeRef = useRef<ActivePick | null>(null);
  // Drawing mode to restore when the pick ends.
  const suspendedDrawingRef = useRef<DrawingMode | null>(null);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;

  const end = useCallback(() => {
    activeRef.current = null;
    setActive(null);

    const suspended = suspendedDrawingRef.current;
    suspendedDrawingRef.current = null;

    if (suspended && suspended !== "none") {
      drawingRef.current.setMode(suspended);
    }
  }, []);

  const begin = useCallback((pick: ActivePick) => {
    if (!activeRef.current) {
      suspendedDrawingRef.current = drawingRef.current.mode;
    }

    if (drawingRef.current.mode !== "none") {
      drawingRef.current.setMode("none");
    }

    activeRef.current = pick;
    setActive(pick);
  }, []);

  const setMarker = useCallback<MapPicker["setMarker"]>(
    (owner, target, coordinates) => {
      mapRef.current?.setPickMarker(
        `${owner}:${target}`,
        MARKER_ROLES[target],
        coordinates,
      );
    },
    [mapRef],
  );

  const pickPoint = useCallback<MapPicker["pickPoint"]>(
    (owner, target, instruction, onPick) => {
      if (!mapRef.current) return;

      begin({ owner, target, instruction });
      mapRef.current.startMapPick({
        mode: "point",
        onPick: (coordinates) => {
          end();
          setMarker(owner, target, coordinates);
          onPick(coordinates);
        },
      });
    },
    [mapRef, begin, end, setMarker],
  );

  const pickFeature = useCallback<MapPicker["pickFeature"]>(
    (owner, target, instruction, geometryTypes, onPick) => {
      if (!mapRef.current) return;

      begin({ owner, target, instruction });
      mapRef.current.startMapPick({
        mode: "feature",
        geometryTypes,
        onPick: (feature) => {
          end();
          onPick(feature);
        },
      });
    },
    [mapRef, begin, end],
  );

  const cancel = useCallback<MapPicker["cancel"]>(
    (owner) => {
      const current = activeRef.current;

      if (!current || (owner && current.owner !== owner)) return;

      mapRef.current?.cancelMapPick();
      end();
    },
    [mapRef, end],
  );

  const isPicking = useCallback<MapPicker["isPicking"]>(
    (owner, target) =>
      active !== null &&
      active.owner === owner &&
      (target === undefined || active.target === target),
    [active],
  );

  useEffect(() => {
    if (!active) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") cancel();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active, cancel]);

  return useMemo(
    () => ({ active, isPicking, pickPoint, pickFeature, cancel, setMarker }),
    [active, isPicking, pickPoint, pickFeature, cancel, setMarker],
  );
}

export function formatLonLat([longitude, latitude]: [number, number]) {
  return `${longitude.toFixed(5)}, ${latitude.toFixed(5)}`;
}
