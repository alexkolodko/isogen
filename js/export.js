const Export = (() => {
  // Pixels per meter at the current map viewport center
  function _pxPerMeter(map) {
    const c = map.getCenter();
    const p1 = map.project([c.lng, c.lat]);
    const p2 = map.project([c.lng + 0.0001, c.lat]);
    const mPerDeg = 111320 * Math.cos(c.lat * Math.PI / 180);
    return Math.abs(p2.x - p1.x) / (mPerDeg * 0.0001);
  }

  function _pt(map, lon, lat) {
    const p = map.project([lon, lat]);
    return [p.x, p.y];
  }

  function _bbox() {
    return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  }

  function _extendBBox(b, x, y) {
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  }

  function _lineCoords(map, lon1, lat1, lon2, lat2, bbox) {
    const [x1, y1] = _pt(map, lon1, lat1);
    const [x2, y2] = _pt(map, lon2, lat2);
    _extendBBox(bbox, x1, y1);
    _extendBBox(bbox, x2, y2);
    return [x1, y1, x2, y2];
  }

  function _svgStartPoint(map, lon, lat, ppm, parts, bbox) {
    const [x, y] = _pt(map, lon, lat);
    const r = 40 * ppm;
    _extendBBox(bbox, x - r, y - r);
    _extendBBox(bbox, x + r, y + r);
    parts.push(`  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#FFFFFF"/>`);
  }

  function exportSVG(map, graph, distMap, maxTimeSec, vizMode, startLng, startLat) {
    const ppm = _pxPerMeter(map);
    const parts = [];
    const bbox = _bbox();
    let pad = 2.5;

    if (vizMode === 'streets') {
      pad = _svgStreets(map, graph, distMap, maxTimeSec, parts, bbox);
    } else {
      pad = _svgIsochrone(map, graph, distMap, maxTimeSec, ppm, parts, bbox);
    }

    if (startLng != null && startLat != null) {
      _svgStartPoint(map, startLng, startLat, ppm, parts, bbox);
      pad = Math.max(pad, Math.max(5, 10 * ppm));
    }

    const w = map.getContainer().offsetWidth;
    const h = map.getContainer().offsetHeight;
    const hasContent = bbox.minX <= bbox.maxX && bbox.minY <= bbox.maxY;
    const x = hasContent ? bbox.minX - pad : 0;
    const y = hasContent ? bbox.minY - pad : 0;
    const vw = hasContent ? bbox.maxX - bbox.minX + pad * 2 : w;
    const vh = hasContent ? bbox.maxY - bbox.minY + pad * 2 : h;

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x.toFixed(1)} ${y.toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}" width="${Math.round(vw)}" height="${Math.round(vh)}">`,
      ...parts,
      '</svg>',
    ].join('\n');
  }

  function _svgStreets(map, graph, distMap, maxTimeSec, parts, bbox) {
    const strokeW = 2.5;
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
    for (let i = 0; i < N; i++) {
      if (buckets[i].length === 0) continue;
      const color = Colors.interpolateColor(i / (N - 1));
      parts.push(`  <g stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round" fill="none">`);
      for (const [[lon1, lat1], [lon2, lat2]] of buckets[i]) {
        const [x1, y1, x2, y2] = _lineCoords(map, lon1, lat1, lon2, lat2, bbox);
        parts.push(`    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
      }
      parts.push('  </g>');
    }
    return strokeW / 2;
  }

  function _svgIsochrone(map, graph, distMap, maxTimeSec, ppm, parts, bbox) {
    // Use thick SVG strokes — same visual as Turf buffer but native SVG, scales to any size.
    const strokeW = Math.max(4, 90 * ppm * 2);
    const N = Colors.BANDS.length;

    // Sort all reachable edges by time for cumulative render
    const reachable = [];
    for (const { nodeA, nodeB, coords, highway } of graph.edges) {
      const dA = distMap.get(nodeA) ?? Infinity;
      const dB = distMap.get(nodeB) ?? Infinity;
      const edgeTime = Math.min(dA, dB);
      if (edgeTime <= maxTimeSec) reachable.push({ nodeA, nodeB, coords, edgeTime, highway });
    }
    reachable.sort((a, b) => a.edgeTime - b.edgeTime);

    const reachableRoads = reachable.filter(e => Graph.isRoadHighway(e.highway));
    const sourceId = Graph.findSourceNode(distMap);

    // Outer → inner: band N-1 (all edges) painted first, band 0 (closest) last
    for (let i = N - 1; i >= 0; i--) {
      const threshold = ((i + 1) / N) * maxTimeSec;
      const color = Colors.BANDS[i].color;
      const eligible = reachable.filter(e => e.edgeTime <= threshold);
      if (eligible.length === 0) continue;
      parts.push(`  <g stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round" stroke-opacity="1" fill="none">`);
      for (const { coords: [[lon1, lat1], [lon2, lat2]] } of eligible) {
        const [x1, y1, x2, y2] = _lineCoords(map, lon1, lat1, lon2, lat2, bbox);
        parts.push(`    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
      }
      parts.push('  </g>');
    }

    // White roads: grow from source per band — connected branches only
    const whiteBands = Graph.buildWhiteRoadBands(reachableRoads, sourceId, maxTimeSec, N);
    const whiteLines = [];
    for (let i = N - 1; i >= 0; i--) {
      for (const feature of whiteBands[i]) {
        const whiteW = feature.properties.width;
        const [[lon1, lat1], [lon2, lat2]] = feature.geometry.coordinates;
        const [x1, y1, x2, y2] = _lineCoords(map, lon1, lat1, lon2, lat2, bbox);
        whiteLines.push(`    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${whiteW}"/>`);
      }
    }
    if (whiteLines.length > 0) {
      parts.push(`  <g stroke="${Colors.roadColor()}" stroke-linecap="round" stroke-opacity="0.92" fill="none">`);
      parts.push(...whiteLines);
      parts.push('  </g>');
    }

    return strokeW / 2;
  }

  function _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function download(svgString, filename) {
    _downloadBlob(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }), filename);
  }

  function downloadPNG(svgString, filename, scale = 2) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }));
      const img = new Image();

      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);

        canvas.toBlob(blob => {
          if (!blob) {
            reject(new Error('PNG export failed'));
            return;
          }
          _downloadBlob(blob, filename);
          resolve();
        }, 'image/png');
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load SVG for PNG export'));
      };

      img.src = url;
    });
  }

  return { exportSVG, download, downloadPNG };
})();
