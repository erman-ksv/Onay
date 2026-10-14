/** The small Leaflet surface used by the stop picker; no React wrapper is required. */
declare module "leaflet" {
  export type LatLngExpression = [number, number] | { lat: number; lng: number };
  export interface LatLng { lat: number; lng: number }
  export interface LeafletMouseEvent { latlng: LatLng }
  export interface Map {
    setView(center: LatLngExpression, zoom: number): this;
    getCenter(): LatLng;
    on(type: "click", handler: (event: LeafletMouseEvent) => void): this;
    invalidateSize(options?: { pan?: boolean }): this;
    remove(): void;
  }
  export interface TileLayer {
    addTo(map: Map): this;
    on(type: "tileload" | "tileerror", handler: () => void): this;
  }
  export interface CircleMarker {
    addTo(map: Map): this;
    setLatLng(point: LatLngExpression): this;
    remove(): void;
  }
  export function map(element: HTMLElement, options?: { zoomControl?: boolean; keyboard?: boolean }): Map;
  export function tileLayer(url: string, options: { attribution: string; maxZoom?: number; crossOrigin?: string }): TileLayer;
  export function circleMarker(point: LatLngExpression, options: { radius: number; color: string; weight: number; fillColor: string; fillOpacity: number; interactive: boolean; className: string }): CircleMarker;
  export const control: {
    zoom(options: { zoomInTitle: string; zoomOutTitle: string }): { addTo(map: Map): void };
  };
}
