const Renderer = (() => {
  const _layers = [];
  const _sources = [];

  function _add(map, id, geojson, type, paint, layout = {}) {
    map.addSource(id, { type: 'geojson', data: geojson });
    map.addLayer({ id, type, source: id, paint, layout });
    _sources.push(id);
    _layers.push(id);
  }

  function clearLayers(map) {
    for (const id of [..._layers]) {
      try { if (map.getLayer(id)) map.removeLayer(id); } catch (_) {}
    }
    for (const id of [..._sources]) {
      try { if (map.getSource(id)) map.removeSource(id); } catch (_) {}
    }
    _layers.length = 0;
    _sources.length = 0;
  }

  function renderStreets(map, graph, distMap, maxTimeSec) {
    const N = 100;
    const buckets = Array.from({ length: N }, () => []);

    for (const { nodeA, nodeB, coords } of graph.edges) {
      const dA = distMap.get(nodeA) ?? Infinity;
      const dB = distMap.get(nodeB) ?? Infinity;
      const t = Math.min(dA, dB);
      if (t > maxTimeSec) continue;
      const idx = Math.min(N - 1, Math.floor((t / maxTimeSec) * N));
      buckets[idx].push(coords);
    }

    const features = [];
    for (let i = 0; i < N; i++) {
      if (buckets[i].length === 0) continue;
      features.push({
        type: 'Feature',
        properties: { color: Colors.interpolateColor(i / (N - 1)) },
        geometry: { type: 'MultiLineString', coordinates: buckets[i] },
      });
    }

    _add(map, 'streets', { type: 'FeatureCollection', features }, 'line', {
      'line-color': ['get', 'color'],
      'line-width': 2.5,
      'line-opacity': 0.95,
    });
  }

  // Isochrone half-width around each reachable edge, meters (matches SVG export)
  const ISO_BUFFER_M = 90;

  // Zoom-dependent line width (px) that stays `meters` wide on the ground
  function _metersToLineWidth(map, meters) {
    const lat = map.getCenter().lat;
    const metersPerPxZ0 = 40075016.686 * Math.cos(lat * Math.PI / 180) / 512;
    const w0 = meters / metersPerPxZ0;
    return ['interpolate', ['exponential', 2], ['zoom'], 0, w0, 24, w0 * 2 ** 24];
  }

  async function renderIsochrone(map, graph, distMap, maxTimeSec, onProgress, streetOverlay = null) {
    // Cumulative approach: band i strokes all edges reachable within (i+1)/N * maxTime.
    // Inner bands render last and paint over outer → clean concentric zones.
    // Thick lines with a fixed ground width (same as SVG export) instead of buffered polygons,
    // so large drive networks render every edge without sampling.
    const N = Colors.BANDS.length;
    const bandWidth = _metersToLineWidth(map, ISO_BUFFER_M * 2);

    // Pre-sort all reachable edges by time
    const reachable = [];
    for (const { nodeA, nodeB, coords, highway } of graph.edges) {
      const dA = distMap.get(nodeA) ?? Infinity;
      const dB = distMap.get(nodeB) ?? Infinity;
      const edgeTime = Math.min(dA, dB);
      if (edgeTime <= maxTimeSec) reachable.push({ nodeA, nodeB, coords, edgeTime, highway });
    }
    reachable.sort((a, b) => a.edgeTime - b.edgeTime);

    const reachableRoads = reachable.filter(e => Graph.isRoadHighway(e.highway));

    // Render outer → inner: band N-1 (purple) = ALL edges, band 0 (white) = closest 1/N
    for (let i = N - 1; i >= 0; i--) {
      const threshold = ((i + 1) / N) * maxTimeSec;
      // All edges up to this band's time threshold (cumulative)
      const eligible = reachable.filter(e => e.edgeTime <= threshold);
      if (eligible.length === 0) continue;

      if (onProgress) onProgress(i, N);
      await new Promise(r => setTimeout(r, 0));

      _add(map, `iso-band-${i}`, {
        type: 'Feature',
        geometry: { type: 'MultiLineString', coordinates: eligible.map(e => e.coords) },
      }, 'line', {
        'line-color': Colors.BANDS[i].color,
        'line-width': bandWidth,
      }, {
        'line-cap': 'round',
        'line-join': 'round',
      });
    }

    if (streetOverlay && reachable.length > 0) {
      _add(map, 'iso-street-overlay', {
        type: 'FeatureCollection',
        features: Graph.buildStreetOverlay(reachable, maxTimeSec, streetOverlay),
      }, 'line', {
        'line-color': Graph.STREET_OVERLAY_COLOR,
        'line-width': ['get', 'width'],
      }, {
        'line-cap': 'round',
        'line-join': 'round',
      });
    }

    // White roads: grow from source per band — no detached segments from sampling
    const sourceId = Graph.findSourceNode(distMap);
    const whiteBands = Graph.buildWhiteRoadBands(reachableRoads, sourceId, maxTimeSec, N);
    const whiteFeatures = [];
    for (let i = N - 1; i >= 0; i--) {
      if (whiteBands[i].length === 0) continue;
      whiteFeatures.push(...whiteBands[i]);
    }

    if (whiteFeatures.length > 0) {
      _add(map, 'iso-road-white', {
        type: 'FeatureCollection',
        features: whiteFeatures,
      }, 'line', {
        'line-color': Colors.roadColor(),
        'line-width': ['get', 'width'],
        'line-opacity': 0.92,
      }, {
        'line-cap': 'round',
        'line-join': 'round',
      });
    }
  }

  const START_SOURCE = 'start-point';
  const START_LAYER = 'start-point';

  function showStartPoint(map, lng, lat) {
    const data = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
    };
    if (map.getSource(START_SOURCE)) {
      map.getSource(START_SOURCE).setData(data);
      if (map.getLayer(START_LAYER)) map.moveLayer(START_LAYER);
      return;
    }
    map.addSource(START_SOURCE, { type: 'geojson', data });
    map.addLayer({
      id: START_LAYER,
      type: 'circle',
      source: START_SOURCE,
      paint: {
        'circle-radius': 8,
        'circle-color': '#FFFFFF',
      },
    });
  }

  function clearStartPoint(map) {
    try { if (map.getLayer(START_LAYER)) map.removeLayer(START_LAYER); } catch (_) {}
    try { if (map.getSource(START_SOURCE)) map.removeSource(START_SOURCE); } catch (_) {}
  }

  return { clearLayers, renderStreets, renderIsochrone, showStartPoint, clearStartPoint };
})();
