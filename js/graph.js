const Graph = (() => {
  const ROAD_HIGHWAYS = new Set([
    'motorway', 'motorway_link',
    'trunk', 'trunk_link',
    'primary', 'primary_link',
    'secondary', 'secondary_link',
    'tertiary', 'tertiary_link',
    'unclassified', 'residential', 'living_street', 'service',
  ]);

  const SPEEDS = {
    walk: {
      primary: 1.389, secondary: 1.389, tertiary: 1.389,
      unclassified: 1.389, residential: 1.389, living_street: 1.389,
      service: 1.0, pedestrian: 1.389, footway: 1.389,
      cycleway: 1.667, path: 1.0, track: 0.8,
    },
    drive: {
      motorway: 27.778, trunk: 22.222,
      primary: 16.667, secondary: 13.889, tertiary: 11.111,
      unclassified: 8.333, residential: 5.556, living_street: 2.778,
      service: 4.167,
    },
  };

  // Free-flow speeds ignore traffic lights and congestion
  const DRIVE_TRAFFIC_FACTOR = 0.7;

  function edgeSpeed(tags, mode) {
    const hw = tags.highway;
    if (mode !== 'drive') return SPEEDS[mode]?.[hw];
    // *_link ramps take the parent class speed
    const base = SPEEDS.drive[hw] ?? SPEEDS.drive[hw?.replace(/_link$/, '')];
    if (!base) return undefined;
    const maxspeed = parseInt(tags.maxspeed, 10);
    const speed = maxspeed > 0 ? maxspeed / 3.6 : base;
    return speed * DRIVE_TRAFFIC_FACTOR;
  }

  // 1 = forward only, -1 = backward only, 0 = both. Pedestrians ignore oneway.
  function onewayDir(tags, mode) {
    if (mode !== 'drive') return 0;
    const o = tags.oneway;
    if (o === '-1' || o === 'reverse') return -1;
    if (o === 'yes' || o === '1' || o === 'true') return 1;
    if (o === 'no') return 0;
    if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
    if (tags.highway === 'motorway') return 1;
    return 0;
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function buildGraph(osmData, mode) {
    const { nodes: nodeMap, ways } = osmData;
    const adj = new Map();
    const edges = [];

    for (const way of ways) {
      const hw = way.tags?.highway;
      const speed = edgeSpeed(way.tags || {}, mode);
      if (!speed) continue;

      const dir = onewayDir(way.tags || {}, mode);

      for (let i = 0; i < way.nodes.length - 1; i++) {
        const aId = way.nodes[i];
        const bId = way.nodes[i + 1];
        const a = nodeMap.get(aId);
        const b = nodeMap.get(bId);
        if (!a || !b) continue;

        const dist = haversine(a.lat, a.lon, b.lat, b.lon);
        if (dist < 0.5) continue;
        const time = dist / speed;

        if (!adj.has(aId)) adj.set(aId, []);
        if (!adj.has(bId)) adj.set(bId, []);

        if (dir >= 0) adj.get(aId).push({ to: bId, time });
        if (dir <= 0) adj.get(bId).push({ to: aId, time });

        edges.push({
          nodeA: aId,
          nodeB: bId,
          coords: [[a.lon, a.lat], [b.lon, b.lat]],
          highway: hw,
        });
      }
    }

    return { nodes: nodeMap, adj, edges };
  }

  function nearestNode(graph, lon, lat) {
    let bestId = null, bestD = Infinity;
    for (const [id, { lat: nLat, lon: nLon }] of graph.nodes) {
      if (!graph.adj.has(id)) continue;
      const d = (nLat - lat) ** 2 + (nLon - lon) ** 2;
      if (d < bestD) { bestD = d; bestId = id; }
    }
    return bestId;
  }

  function isRoadHighway(highway) {
    return highway != null && ROAD_HIGHWAYS.has(highway);
  }

  // Innermost band (start) → widest; each outer band one step narrower.
  const WHITE_ROAD_WIDTHS = [8, 6, 5, 4, 3];

  function whiteRoadWidth(bandIdx) {
    return WHITE_ROAD_WIDTHS[Math.min(bandIdx, WHITE_ROAD_WIDTHS.length - 1)];
  }

  function findSourceNode(distMap) {
    let bestId = null;
    let bestDist = Infinity;
    for (const [id, d] of distMap) {
      if (d < bestDist) {
        bestDist = d;
        bestId = id;
      }
    }
    return bestId;
  }

  // Grow road edges from source by time band so each new segment branches off the network.
  function buildWhiteRoadBands(roadEdges, sourceId, maxTimeSec, numBands) {
    const sorted = roadEdges
      .filter(e => e.edgeTime <= maxTimeSec)
      .sort((a, b) => a.edgeTime - b.edgeTime);

    const includedNodes = new Set(sourceId != null ? [sourceId] : []);
    const assigned = [];
    let edgeIdx = 0;
    const bands = [];

    for (let band = 0; band < numBands; band++) {
      const threshold = ((band + 1) / numBands) * maxTimeSec;

      while (edgeIdx < sorted.length && sorted[edgeIdx].edgeTime <= threshold) {
        const edge = sorted[edgeIdx++];
        if (!includedNodes.has(edge.nodeA) && !includedNodes.has(edge.nodeB)) continue;
        includedNodes.add(edge.nodeA);
        includedNodes.add(edge.nodeB);
        assigned.push(edge);
      }

      const width = whiteRoadWidth(band);
      bands.push(assigned.map(e => ({
        type: 'Feature',
        properties: { width },
        geometry: { type: 'LineString', coordinates: e.coords },
      })));
    }

    return bands;
  }

  // All reachable edges as overlay lines; width shrinks linearly with travel time.
  const STREET_OVERLAY_COLOR = '#9FF588';
  const STREET_OVERLAY_WIDTH = { max: 5, min: 1 };

  const MAJOR_HIGHWAYS = new Set([
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link',
  ]);

  // detail: 'major' (main roads), 'roads' (no service/footpaths), 'all'
  function matchesDetail(highway, detail) {
    if (detail === 'major') return MAJOR_HIGHWAYS.has(highway);
    if (detail === 'roads') return isRoadHighway(highway) && highway !== 'service';
    return true;
  }

  function buildStreetOverlay(reachable, maxTimeSec, detail = 'all') {
    const { max, min } = STREET_OVERLAY_WIDTH;
    // Farthest first so thicker inner lines paint on top
    return reachable
      .filter(e => matchesDetail(e.highway, detail))
      .sort((a, b) => b.edgeTime - a.edgeTime)
      .map(e => ({
        type: 'Feature',
        properties: { width: +(max - (max - min) * (e.edgeTime / maxTimeSec)).toFixed(2) },
        geometry: { type: 'LineString', coordinates: e.coords },
      }));
  }

  return {
    buildGraph,
    buildStreetOverlay,
    STREET_OVERLAY_COLOR,
    nearestNode,
    findSourceNode,
    isRoadHighway,
    whiteRoadWidth,
    buildWhiteRoadBands,
  };
})();
