// Road network from OpenFreeMap vector tiles (same OSM data the basemap uses).
// Returns the same { nodes, ways } shape as Overpass so Graph.buildGraph works unchanged.
const Tiles = (() => {
  const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
  const MAX_ZOOM = 14;   // full road detail lives at z14
  const MAX_TILES = 150; // drop zoom for big drive radii (lower zooms keep major roads only)

  let _tileUrl = null;
  let _libs = null;

  async function _loadLibs() {
    if (!_libs) {
      const [vt, pbf] = await Promise.all([
        import('https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.3/+esm'),
        import('https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm'),
      ]);
      _libs = { VectorTile: vt.VectorTile, Pbf: pbf.default };
    }
    return _libs;
  }

  async function _getTileUrl() {
    if (!_tileUrl) {
      const res = await fetch(TILEJSON_URL);
      if (!res.ok) throw new Error(`TileJSON HTTP ${res.status}`);
      _tileUrl = (await res.json()).tiles[0];
    }
    return _tileUrl;
  }

  function _lon2x(lon, z) { return (lon + 180) / 360 * 2 ** z; }
  function _lat2y(lat, z) {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
  }
  function _x2lon(x, z) { return x / 2 ** z * 360 - 180; }
  function _y2lat(y, z) {
    const n = Math.PI - 2 * Math.PI * y / 2 ** z;
    return 180 / Math.PI * Math.atan(Math.sinh(n));
  }

  function _tileRange(lat, lon, radiusM, z) {
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
    const x0 = Math.floor(_lon2x(lon - dLon, z)), x1 = Math.floor(_lon2x(lon + dLon, z));
    const y0 = Math.floor(_lat2y(lat + dLat, z)), y1 = Math.floor(_lat2y(lat - dLat, z));
    return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  }

  // OpenMapTiles class → OSM highway tag understood by Graph
  function _highway(p) {
    const ramp = p.ramp === 1 ? '_link' : '';
    switch (p.class) {
      case 'motorway': case 'trunk': case 'primary': case 'secondary': case 'tertiary':
        return p.class + ramp;
      case 'minor': return 'residential';
      case 'service': return 'service';
      case 'track': return 'track';
      case 'path':
        return ['pedestrian', 'footway', 'cycleway', 'path'].includes(p.subclass) ? p.subclass : 'path';
      default: return null;
    }
  }

  function _wayTags(p, mode) {
    if (mode === 'drive' && p.access === 'no') return null;
    const highway = _highway(p);
    if (!highway) return null;
    const tags = { highway };
    if (p.oneway === 1) tags.oneway = 'yes';
    else if (p.oneway === -1) tags.oneway = '-1';
    return tags;
  }

  async function fetchRoadNetwork(lat, lon, radiusM, mode, onProgress) {
    const [{ VectorTile, Pbf }, tileUrl] = await Promise.all([_loadLibs(), _getTileUrl()]);

    let z = MAX_ZOOM;
    let range = _tileRange(lat, lon, radiusM, z);
    while (range.count > MAX_TILES && z > 10) range = _tileRange(lat, lon, radiusM, --z);

    const jobs = [];
    for (let x = range.x0; x <= range.x1; x++) {
      for (let y = range.y0; y <= range.y1; y++) jobs.push({ x, y });
    }

    // Vertices are keyed by global tile-grid coordinates, so points shared between
    // features (and between neighbouring tiles' buffers) map to the same node.
    const coords = new Map(); // id → [gx, gy]
    const ways = [];          // { ids, tags, layer }
    const seenSegments = new Set();
    let ext = 4096;
    let done = 0;

    async function loadTile({ x, y }) {
      const url = tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Тайл ${z}/${x}/${y}: HTTP ${res.status}`);
      const tile = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())));
      const layer = tile.layers.transportation;
      if (layer) {
        ext = layer.extent;
        for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i);
          if (f.type !== 2) continue; // lines only
          const p = f.properties;
          const tags = _wayTags(p, mode);
          if (!tags) continue;
          const wayLayer = p.layer ?? (p.brunnel === 'bridge' ? 1 : p.brunnel === 'tunnel' ? -1 : 0);
          for (const line of f.loadGeometry()) {
            const ids = line.map(pt => {
              const gx = x * ext + pt.x, gy = y * ext + pt.y;
              const id = gx + ',' + gy;
              if (!coords.has(id)) coords.set(id, [gx, gy]);
              return id;
            });
            // Drop segments already seen in a neighbouring tile's buffer
            let run = [];
            for (let k = 1; k < ids.length; k++) {
              const a = ids[k - 1], b = ids[k];
              if (a === b) continue;
              const key = a < b ? a + '|' + b : b + '|' + a;
              if (seenSegments.has(key)) {
                if (run.length > 1) ways.push({ ids: run, tags, layer: wayLayer });
                run = [];
                continue;
              }
              seenSegments.add(key);
              if (run.length === 0) run.push(a);
              run.push(b);
            }
            if (run.length > 1) ways.push({ ids: run, tags, layer: wayLayer });
          }
        }
      }
      if (onProgress) onProgress(++done, jobs.length);
    }

    // Small concurrency pool
    const queue = [...jobs];
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (queue.length) await loadTile(queue.shift());
    }));

    const stitched = _stitch(ways, coords);
    const zg = z + Math.log2(ext); // zoom of the global grid
    const nodes = new Map();
    for (const w of stitched) {
      for (const id of w.nodes) {
        if (nodes.has(id)) continue;
        const [gx, gy] = coords.get(id);
        nodes.set(id, { lat: _y2lat(gy, zg), lon: _x2lon(gx, zg) });
      }
    }
    return { nodes, ways: stitched, zoom: z };
  }

  // Tile geometry is simplified per tile, so a junction vertex often survives on only
  // one of the crossing roads. Snap every vertex to nearby vertices / segments of
  // other ways on the same layer (bridge/tunnel ends may join any layer).
  const SNAP_UNITS = 12; // ≈ 4–5 m at z14 (tile grid units)
  const CELL = 64;

  function _stitch(ways, coords) {
    const parent = new Map();
    const find = id => {
      let r = id;
      while (parent.has(r)) r = parent.get(r);
      while (parent.has(id)) { const n = parent.get(id); parent.set(id, r); id = n; }
      return r;
    };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(a, b); };

    // Vertex info: layers it sits on, and whether it ends a bridge/tunnel way
    const vLayers = new Map();
    const vBrunnelEnd = new Set();
    ways.forEach(w => {
      w.ids.forEach((id, k) => {
        if (!vLayers.has(id)) vLayers.set(id, new Set());
        vLayers.get(id).add(w.layer);
        if (w.layer !== 0 && (k === 0 || k === w.ids.length - 1)) vBrunnelEnd.add(id);
      });
    });

    // Spatial grid of segments
    const grid = new Map();
    const cellKey = (cx, cy) => cx + ',' + cy;
    ways.forEach((w, wi) => {
      for (let k = 1; k < w.ids.length; k++) {
        const [x1, y1] = coords.get(w.ids[k - 1]);
        const [x2, y2] = coords.get(w.ids[k]);
        const cx0 = Math.floor((Math.min(x1, x2) - SNAP_UNITS) / CELL);
        const cx1 = Math.floor((Math.max(x1, x2) + SNAP_UNITS) / CELL);
        const cy0 = Math.floor((Math.min(y1, y2) - SNAP_UNITS) / CELL);
        const cy1 = Math.floor((Math.max(y1, y2) + SNAP_UNITS) / CELL);
        for (let cx = cx0; cx <= cx1; cx++) {
          for (let cy = cy0; cy <= cy1; cy++) {
            const key = cellKey(cx, cy);
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(wi, k);
          }
        }
      }
    });

    // inserts: "wi:k" → [{ t, id }] points to splice into segment k of way wi
    const inserts = new Map();
    const tol2 = SNAP_UNITS * SNAP_UNITS;
    for (const [id, layers] of vLayers) {
      const [px, py] = coords.get(id);
      const cell = grid.get(cellKey(Math.floor(px / CELL), Math.floor(py / CELL)));
      if (!cell) continue;
      const anyLayer = vBrunnelEnd.has(id);
      for (let j = 0; j < cell.length; j += 2) {
        const wi = cell[j], k = cell[j + 1];
        const w = ways[wi];
        if (!anyLayer && !layers.has(w.layer)) continue;
        const a = w.ids[k - 1], b = w.ids[k];
        if (a === id || b === id) continue;
        const [x1, y1] = coords.get(a);
        const [x2, y2] = coords.get(b);
        const dx = x2 - x1, dy = y2 - y1;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
        const qx = x1 + t * dx - px, qy = y1 + t * dy - py;
        if (qx * qx + qy * qy > tol2) continue;
        if (t === 0) union(id, a);
        else if (t === 1) union(id, b);
        else {
          const key = wi + ':' + k;
          if (!inserts.has(key)) inserts.set(key, []);
          inserts.get(key).push({ t, id });
        }
      }
    }

    return ways.map((w, wi) => {
      const nodes = [find(w.ids[0])];
      for (let k = 1; k < w.ids.length; k++) {
        const extra = inserts.get(wi + ':' + k);
        if (extra) extra.sort((p, q) => p.t - q.t).forEach(e => nodes.push(find(e.id)));
        nodes.push(find(w.ids[k]));
      }
      return { nodes: nodes.filter((id, i) => i === 0 || id !== nodes[i - 1]), tags: w.tags };
    }).filter(w => w.nodes.length > 1);
  }

  return { fetchRoadNetwork };
})();
