const Dijkstra = (() => {
  class MinHeap {
    constructor() { this._h = []; }

    push(w, id) {
      this._h.push({ w, id });
      this._up(this._h.length - 1);
    }

    pop() {
      const top = this._h[0];
      const last = this._h.pop();
      if (this._h.length > 0) {
        this._h[0] = last;
        this._down(0);
      }
      return top;
    }

    get size() { return this._h.length; }

    _up(i) {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this._h[p].w <= this._h[i].w) break;
        [this._h[p], this._h[i]] = [this._h[i], this._h[p]];
        i = p;
      }
    }

    _down(i) {
      const n = this._h.length;
      while (true) {
        let s = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < n && this._h[l].w < this._h[s].w) s = l;
        if (r < n && this._h[r].w < this._h[s].w) s = r;
        if (s === i) break;
        [this._h[s], this._h[i]] = [this._h[i], this._h[s]];
        i = s;
      }
    }
  }

  function dijkstra(graph, sourceId) {
    const dist = new Map();
    const visited = new Set();
    const pq = new MinHeap();

    dist.set(sourceId, 0);
    pq.push(0, sourceId);

    while (pq.size > 0) {
      const { w, id: u } = pq.pop();
      if (visited.has(u)) continue;
      visited.add(u);

      for (const edge of (graph.adj.get(u) || [])) {
        const nw = w + edge.time;
        if (!dist.has(edge.to) || nw < dist.get(edge.to)) {
          dist.set(edge.to, nw);
          pq.push(nw, edge.to);
        }
      }
    }

    return dist;
  }

  return { dijkstra };
})();
