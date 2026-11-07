/**
 * Leaflet 地图封装。
 *
 * 坐标说明（2026-11 实测）：
 * - 本应用使用的高德栅格瓦片（webrd / webst）在 Leaflet 标准 Web Mercator 下
 *   与 WGS-84 直接对齐：GPS 原始坐标无需偏移即可落在地图正确位置。
 * - 因此地图显示、轨迹、地图选点都直接使用 WGS-84；GCJ-02 仅作为附加显示/导出
 *   坐标，方便粘贴到高德系工具，不参与地图渲染。
 * - 高德栅格瓦片为非官方接口，失败不影响定位、记录与导出。
 */

import {
  AMAP_ATTRIBUTION,
  AMAP_SUBDOMAINS,
  AMAP_TILES,
} from './constants.js';
import { isValidLatLng } from './geo.js';

const TRACK_COLOR = '#2fb4ff';
const START_COLOR = '#22c55e';
const END_COLOR = '#ff5d73';

function requireLeaflet() {
  if (typeof L === 'undefined') {
    throw new Error('Leaflet 未加载，请检查 vendor/leaflet/leaflet.js');
  }
  return L;
}

function compareSeq(a, b) {
  return (a.seq ?? 0) - (b.seq ?? 0);
}

function groupBySegment(points) {
  const map = new Map();
  for (const point of [...(points || [])].sort(compareSeq)) {
    const segment = Number.isFinite(point.segment) ? point.segment : 0;
    if (!map.has(segment)) map.set(segment, []);
    map.get(segment).push(point);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

export class MapView {
  /**
   * @param {HTMLElement} container
   * @param {{basemap?:string, center?:{lat:number,lng:number}, zoom?:number}} [options]
   */
  constructor(container, options = {}) {
    const L = requireLeaflet();
    this.L = L;
    this.container = container;
    this.basemap = options.basemap === 'satellite' ? 'satellite' : 'vector';
    this.tileLayer = null;
    this.tileErrors = 0;
    this.currentMarker = null;
    this.accuracyCircle = null;
    this.waypointMarker = null;
    this.segmentLayers = new Map();
    this.trackOverlays = [];
    this.pickOff = null;
    this.destroyed = false;

    this.map = L.map(container, {
      zoomControl: true,
      scrollWheelZoom: false,
      preferCanvas: true,
      attributionControl: true,
    });
    const center = options.center || { lat: 35, lng: 105 };
    const zoom = Number.isFinite(options.zoom) ? options.zoom : 4;
    this.map.setView(this.toDisplay(center), zoom);
    this.setBasemap(this.basemap);

    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.map);

    this.resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => this.invalidate())
        : null;
    this.resizeObserver?.observe(container);
    requestAnimationFrame(() => this.invalidate());
  }

  /** WGS-84 → Leaflet 显示坐标（当前瓦片实测按 WGS-84 对齐）。 */
  toDisplay(coord) {
    return [coord.lat, coord.lng];
  }

  /** Leaflet 显示坐标 → WGS-84（当前瓦片为同一基准）。 */
  toWgs(lat, lng) {
    return { lat, lng };
  }

  setBasemap(kind) {
    if (this.destroyed) return;
    const L = this.L;
    const next = kind === 'satellite' ? 'satellite' : 'vector';
    if (this.tileLayer) this.map.removeLayer(this.tileLayer);

    this.tileLayer = L.tileLayer(AMAP_TILES[next], {
      subdomains: AMAP_SUBDOMAINS,
      minZoom: 3,
      maxZoom: 19,
      maxNativeZoom: 18,
      tileSize: 256,
      detectRetina: false,
      attribution: AMAP_ATTRIBUTION,
    });

    this.tileLayer.on('tileerror', () => {
      this.tileErrors += 1;
      if (this.tileErrors === 3 && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('app-map-tile-error'));
      }
    });

    this.tileLayer.addTo(this.map);
    this.basemap = next;
  }

  invalidate() {
    if (!this.destroyed) this.map.invalidateSize();
  }

  setViewWgs(coord, zoom) {
    if (this.destroyed) return;
    this.map.setView(this.toDisplay(coord), Number.isFinite(zoom) ? zoom : this.map.getZoom());
  }

  getCenterWgs() {
    const center = this.map.getCenter();
    return this.toWgs(center.lat, center.lng);
  }

  _createCurrentMarker() {
    const L = this.L;
    const icon = L.divIcon({
      className: 'current-dot-icon',
      html: '<span class="current-dot-pulse"></span><span class="current-dot-core"></span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    this.currentMarker = L.marker(this.map.getCenter(), {
      icon,
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(this.map);
    return this.currentMarker;
  }

  /**
   * 更新当前位置标记、精度圆。
   * @param {object} fix WGS-84 fix
   * @param {{follow?:boolean, pan?:boolean}} [options]
   */
  updateCurrent(fix, { follow = false, pan = true } = {}) {
    if (this.destroyed || !isValidLatLng(fix?.lat, fix?.lng)) return;
    const L = this.L;
    const latlng = this.toDisplay(fix);

    if (!this.currentMarker) this._createCurrentMarker();
    this.currentMarker.setLatLng(latlng);

    const accuracy = Number(fix.accuracyM);
    if (Number.isFinite(accuracy) && accuracy > 0) {
      if (!this.accuracyCircle) {
        this.accuracyCircle = L.circle(latlng, {
          radius: accuracy,
          color: '#3fa9f5',
          weight: 1,
          opacity: 0.7,
          fillColor: '#3fa9f5',
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(this.map);
      } else {
        this.accuracyCircle.setLatLng(latlng);
        this.accuracyCircle.setRadius(accuracy);
      }
    } else if (this.accuracyCircle) {
      this.map.removeLayer(this.accuracyCircle);
      this.accuracyCircle = null;
    }

    if (follow && pan) {
      if (this.map.getZoom() < 13) {
        this.map.setView(latlng, 16);
      } else {
        this.map.panTo(latlng, { animate: false });
      }
    }
  }

  clearCurrent() {
    if (this.currentMarker) {
      this.map.removeLayer(this.currentMarker);
      this.currentMarker = null;
    }
    if (this.accuracyCircle) {
      this.map.removeLayer(this.accuracyCircle);
      this.accuracyCircle = null;
    }
  }

  _clearTrackLayers() {
    for (const layer of this.segmentLayers.values()) {
      this.map.removeLayer(layer);
    }
    this.segmentLayers.clear();
    for (const overlay of this.trackOverlays) {
      this.map.removeLayer(overlay);
    }
    this.trackOverlays = [];
  }

  _segmentLayer(segment) {
    let layer = this.segmentLayers.get(segment);
    if (!layer) {
      const L = this.L;
      layer = L.polyline([], {
        color: TRACK_COLOR,
        weight: 4,
        opacity: 0.95,
        lineJoin: 'round',
        lineCap: 'round',
        interactive: false,
      }).addTo(this.map);
      this.segmentLayers.set(segment, layer);
    }
    return layer;
  }

  /** 初始化实时轨迹；points 为已保存的轨迹点。 */
  startLiveTrack(points = []) {
    this._clearTrackLayers();
    for (const [segment, segmentPoints] of groupBySegment(points)) {
      const layer = this._segmentLayer(segment);
      for (const point of segmentPoints) {
        layer.addLatLng(this.toDisplay(point));
      }
    }
  }

  /** 追加一个实时轨迹点。 */
  appendLivePoint(point, segment) {
    if (this.destroyed || !isValidLatLng(point?.lat, point?.lng)) return;
    const index = Number.isFinite(segment) ? segment : 0;
    const layer = this._segmentLayer(index);
    layer.addLatLng(this.toDisplay(point));
  }

  /** 展示完整轨迹并适配视野。 */
  showTrack(points = []) {
    this._clearTrackLayers();
    const groups = groupBySegment(points);
    const L = this.L;

    for (const [segment, segmentPoints] of groups) {
      if (segmentPoints.length >= 2) {
        const layer = this._segmentLayer(segment);
        for (const point of segmentPoints) {
          layer.addLatLng(this.toDisplay(point));
        }
      } else if (segmentPoints.length === 1) {
        const marker = L.circleMarker(this.toDisplay(segmentPoints[0]), {
          radius: 5,
          color: '#ffffff',
          weight: 1,
          fillColor: TRACK_COLOR,
          fillOpacity: 1,
          interactive: false,
        }).addTo(this.map);
        this.trackOverlays.push(marker);
      }
    }

    if (points.length > 0) {
      const sorted = [...points].sort(compareSeq);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const start = L.circleMarker(this.toDisplay(first), {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: START_COLOR,
        fillOpacity: 1,
      })
        .bindTooltip('起点', { direction: 'top' })
        .addTo(this.map);
      this.trackOverlays.push(start);
      if (sorted.length > 1) {
        const end = L.circleMarker(this.toDisplay(last), {
          radius: 7,
          color: '#ffffff',
          weight: 2,
          fillColor: END_COLOR,
          fillOpacity: 1,
        })
          .bindTooltip('终点', { direction: 'top' })
          .addTo(this.map);
        this.trackOverlays.push(end);
      }
      this.fitToPoints(points);
    }
  }

  /** 展示单个已保存点。 */
  showWaypoint(waypoint) {
    const L = this.L;
    this._clearTrackLayers();
    if (this.waypointMarker) {
      this.map.removeLayer(this.waypointMarker);
      this.waypointMarker = null;
    }
    if (!isValidLatLng(waypoint?.lat, waypoint?.lng)) return;
    const latlng = this.toDisplay(waypoint);
    this.waypointMarker = L.marker(latlng).addTo(this.map);
    this.map.setView(latlng, 16);
  }

  fitToPoints(points) {
    if (this.destroyed || !points?.length) return;
    const L = this.L;
    const latlngs = points
      .filter((point) => isValidLatLng(point.lat, point.lng))
      .map((point) => this.toDisplay(point));
    if (!latlngs.length) return;
    if (latlngs.length === 1) {
      this.map.setView(latlngs[0], 17);
      return;
    }
    this.map.fitBounds(L.latLngBounds(latlngs), {
      padding: [28, 28],
      maxZoom: 17,
      animate: false,
    });
  }

  /**
   * 进入地图选点：相机中心即准星位置，移动结束后回调 WGS-84 坐标。
   * @param {(coord:{lat:number,lng:number})=>void} handler
   */
  beginPick(handler) {
    this.endPick();
    const onMove = () => handler?.(this.getCenterWgs());
    this.map.on('moveend', onMove);
    this.pickOff = () => this.map.off('moveend', onMove);
    this.invalidate();
    handler?.(this.getCenterWgs());
    return this.pickOff;
  }

  endPick() {
    this.pickOff?.();
    this.pickOff = null;
  }

  /** 用户主动拖动地图时通知页面（用于暂停自动跟随）。 */
  onUserPan(callback) {
    const onDrag = () => callback?.();
    this.map.on('dragstart', onDrag);
    return () => this.map.off('dragstart', onDrag);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.endPick();
    this._clearTrackLayers();
    this.clearCurrent();
    if (this.waypointMarker) {
      this.map.removeLayer(this.waypointMarker);
      this.waypointMarker = null;
    }
    this.map.remove();
    this.map = null;
    this.container = null;
  }
}
