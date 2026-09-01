(function () {
  "use strict";

  // Cores/nomes conhecidos por classe (legenda global, compartilhada por TODOS
  // os projetos/blocos). Uma classe que apareca num projeto futuro e nao
  // esteja aqui ganha uma cor gerada automaticamente (ver colorForUnknownClass).
  var KNOWN_CLASS_DEFS = {
    1: { name: "Solo",                                   color: "#8B5E34" },
    2: { name: "Roço (até 0,40 m)",                       color: "#F4B400" },
    3: { name: "Poda Leve (0,40 m a 3,00 m)",             color: "#FF8C42" },
    4: { name: "Poda Seletiva (3,00 m a 8,00 m)",         color: "#E63946" },
    6: { name: "Não Identificado",                        color: "#9AA0A6" }
  };
  var FALLBACK_PALETTE = ["#2A9D8F", "#264653", "#E76F51", "#457B9D", "#8AC926", "#B5179E"];
  var DEFAULT_OPACITY = 55; // % (vegetacao)

  // ------------------------------------------------------------------
  // Mapa base
  // ------------------------------------------------------------------
  var map = L.map("map", {
    zoomControl: false,
    minZoom: 3,
    maxZoom: 22
  });
  L.control.zoom({ position: "topright" }).addTo(map);
  L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);
  map.setView([0, 0], 2); // vista generica ate o catalogo carregar e ajustar

  // Em areas rurais o Esri World Imagery costuma nao ter imagem em zooms muito
  // altos e devolve um tile placeholder ("Map data not yet available") em vez
  // de erro. maxNativeZoom trava as requisicoes nesse teto e deixa o Leaflet
  // ampliar (com perda de nitidez, mas sem placeholder) a partir dali.
  var esriLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 22, maxNativeZoom: 17, attribution: "Tiles &copy; Esri" }
  );
  var osmLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  });
  var baseLayers = { esri: esriLayer, osm: osmLayer, none: null };
  var currentBase = null;

  function setBasemap(key) {
    if (currentBase) { map.removeLayer(currentBase); }
    var layer = baseLayers[key];
    currentBase = layer || null;
    if (currentBase) { currentBase.addTo(map); currentBase.bringToBack(); }
  }
  document.querySelectorAll('input[name="basemap"]').forEach(function (el) {
    el.addEventListener("change", function () { setBasemap(this.value); });
  });
  setBasemap("esri");

  // ------------------------------------------------------------------
  // Estado
  // ------------------------------------------------------------------
  // projects[pid] = { id, name, flights: [flightMeta,...], blocks: [nomes distintos, sem null] }
  var projects = {};
  var projectOrder = [];
  var allBounds = null;

  // legend[classId] = { name, color, opacity, visible }
  var legend = {};
  var legendOrder = [];

  // flightKey = pid + "::" + date + "::" + (block || "")
  var orthoByFlight = {};   // flightKey -> L.tileLayer
  var vegByFlight = {};     // flightKey -> { classId: L.geoJSON }
  var vegDataPromiseByFlight = {};
  var activeFlights = {};   // flightKey -> true

  var projectSelect = document.getElementById("projectSelect");
  var projectPanelBody = document.getElementById("projectPanelBody");
  var catalogStatus = document.getElementById("catalogStatus");
  var legendList = document.getElementById("legendList");
  var legendPanel = document.getElementById("legendPanel");

  function flightKey(pid, date, block) { return pid + "::" + date + "::" + (block || ""); }

  function findFlight(pid, date, block) {
    var fls = projects[pid].flights;
    for (var i = 0; i < fls.length; i++) {
      if (fls[i].date === date && (fls[i].block || null) === (block || null)) { return fls[i]; }
    }
    return null;
  }

  function latestFlightForBlock(pid, block) {
    var fls = projects[pid].flights.filter(function (f) { return (f.block || null) === (block || null); });
    return fls[0] || null; // catalog.json ja vem ordenado por data desc
  }

  // ------------------------------------------------------------------
  // Carrega catalogo
  // ------------------------------------------------------------------
  fetch("../data/catalog.json")
    .then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.json();
    })
    .then(function (catalog) {
      var cat = catalog.projects || [];
      if (cat.length === 0) {
        catalogStatus.textContent = "Nenhum projeto no catálogo.";
        return;
      }
      cat.forEach(function (p) { registerProject(p); });
      buildLegendFromCatalog(cat);
      populateProjectSelect();
      populateSwipeSelects();
      catalogStatus.textContent = cat.length + " projeto(s) carregado(s).";
      if (allBounds) { map.fitBounds(allBounds); }

      // ativa automaticamente o primeiro item do primeiro projeto, pra a
      // pagina nao abrir vazia
      var first = cat[0];
      var firstFlight = first.flights[0];
      if (firstFlight) { setFlightActive(first.id, firstFlight.date, firstFlight.block, true); }
      renderProjectPanel(first.id);
    })
    .catch(function (err) {
      catalogStatus.textContent = "Falha ao carregar catálogo: " + err.message;
      catalogStatus.style.color = "#c0392b";
      console.error(err);
    });

  function registerProject(p) {
    var blockSet = {};
    p.flights.forEach(function (fl) { if (fl.block) { blockSet[fl.block] = true; } });
    projects[p.id] = { id: p.id, name: p.name, flights: p.flights, blocks: Object.keys(blockSet) };
    projectOrder.push(p.id);
    p.flights.forEach(function (fl) { extendAllBounds(fl.bounds); });
  }

  function extendAllBounds(boundsArr) {
    var b = L.latLngBounds(boundsArr);
    allBounds = allBounds ? allBounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
  }

  // ------------------------------------------------------------------
  // Legenda global de vegetacao
  // ------------------------------------------------------------------
  function buildLegendFromCatalog(cat) {
    var seen = {};
    cat.forEach(function (p) {
      p.flights.forEach(function (fl) {
        (fl.classes || []).forEach(function (c) { seen[c.id] = seen[c.id] || c.name; });
      });
    });
    var ids = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
    var fallbackIdx = 0;
    ids.forEach(function (cid) {
      var known = KNOWN_CLASS_DEFS[cid];
      var color = known ? known.color : FALLBACK_PALETTE[fallbackIdx++ % FALLBACK_PALETTE.length];
      var name = known ? known.name : seen[cid];
      legend[cid] = { name: name, color: color, opacity: DEFAULT_OPACITY, visible: true };
      legendOrder.push(cid);
    });

    if (legendOrder.length === 0) { legendPanel.hidden = true; return; }
    legendList.innerHTML = legendOrder.map(buildLegendRowHtml).join("");
  }

  function buildLegendRowHtml(cid) {
    var st = legend[cid];
    return (
      '<div class="layer-card">' +
        '<div class="layer-card-head">' +
          '<input type="checkbox" checked data-role="legend-visible" data-class="' + cid + '">' +
          '<span class="layer-name">' + escapeHtml(st.name) + '</span>' +
          '<input type="color" class="color-swatch" value="' + st.color + '" data-role="legend-color" data-class="' + cid + '">' +
        '</div>' +
        '<div class="layer-card-body">' +
          '<span>opacidade</span>' +
          '<input type="range" min="0" max="100" value="' + st.opacity + '" data-role="legend-opacity" data-class="' + cid + '">' +
          '<span class="layer-opacity-val" data-role="legend-opacity-val" data-class="' + cid + '">' + st.opacity + '%</span>' +
        '</div>' +
      '</div>'
    );
  }

  function styleForClass(cid) {
    var st = legend[cid];
    return { color: st.color, weight: 1, opacity: 0.9, fillColor: st.color, fillOpacity: st.opacity / 100 };
  }

  legendList.addEventListener("change", function (e) {
    var role = e.target.getAttribute("data-role");
    var cid = Number(e.target.getAttribute("data-class"));
    if (!role) { return; }
    if (role === "legend-visible") {
      legend[cid].visible = e.target.checked;
      applyClassVisibilityEverywhere(cid);
    } else if (role === "legend-color") {
      legend[cid].color = e.target.value;
      applyClassStyleEverywhere(cid);
    }
  });
  legendList.addEventListener("input", function (e) {
    if (e.target.getAttribute("data-role") !== "legend-opacity") { return; }
    var cid = Number(e.target.getAttribute("data-class"));
    var v = Number(e.target.value);
    legend[cid].opacity = v;
    document.querySelector('[data-role="legend-opacity-val"][data-class="' + cid + '"]').textContent = v + "%";
    applyClassStyleEverywhere(cid);
  });
  document.getElementById("btnResetColors").addEventListener("click", function () {
    legendOrder.forEach(function (cid) {
      var known = KNOWN_CLASS_DEFS[cid];
      if (!known) { return; }
      legend[cid].color = known.color;
      legend[cid].opacity = DEFAULT_OPACITY;
      document.querySelector('[data-role="legend-color"][data-class="' + cid + '"]').value = known.color;
      var op = document.querySelector('[data-role="legend-opacity"][data-class="' + cid + '"]');
      if (op) { op.value = DEFAULT_OPACITY; }
      document.querySelector('[data-role="legend-opacity-val"][data-class="' + cid + '"]').textContent = DEFAULT_OPACITY + "%";
      applyClassStyleEverywhere(cid);
    });
  });

  function applyClassStyleEverywhere(cid) {
    Object.keys(vegByFlight).forEach(function (key) {
      var g = vegByFlight[key][cid];
      if (g) { g.setStyle(styleForClass(cid)); }
    });
  }
  function applyClassVisibilityEverywhere(cid) {
    Object.keys(vegByFlight).forEach(function (key) {
      if (!activeFlights[key]) { return; }
      var g = vegByFlight[key][cid];
      if (!g) { return; }
      if (legend[cid].visible && !map.hasLayer(g)) { map.addLayer(g); }
      if (!legend[cid].visible && map.hasLayer(g)) { map.removeLayer(g); }
    });
  }

  // ------------------------------------------------------------------
  // Ativacao/desativacao de um item (projeto + data + bloco)
  // ------------------------------------------------------------------
  function setFlightActive(pid, date, block, active) {
    var fl = findFlight(pid, date, block);
    if (!fl) { return; }
    var key = flightKey(pid, date, block);
    activeFlights[key] = active;

    if (fl.hasOrtho) { setOrthoActive(pid, fl, key, active); }
    if (fl.hasVegetation) { setVegActive(pid, fl, key, active); }
  }

  function setOrthoActive(pid, fl, key, active) {
    if (active) {
      if (!orthoByFlight[key]) {
        orthoByFlight[key] = L.tileLayer(
          "../data/" + fl.tiles + "/{z}/{x}/{y}." + fl.tileExt,
          {
            minZoom: 3, maxZoom: 22,
            maxNativeZoom: fl.maxNativeZoom, minNativeZoom: fl.minNativeZoom,
            bounds: fl.bounds, attribution: "Ortofoto local — " + projects[pid].name
          }
        );
      }
      orthoByFlight[key].addTo(map);
    } else if (orthoByFlight[key] && map.hasLayer(orthoByFlight[key])) {
      map.removeLayer(orthoByFlight[key]);
    }
  }

  function setVegActive(pid, fl, key, active) {
    if (!active) {
      var groups = vegByFlight[key];
      if (groups) {
        Object.keys(groups).forEach(function (cid) {
          if (map.hasLayer(groups[cid])) { map.removeLayer(groups[cid]); }
        });
      }
      return;
    }

    if (vegByFlight[key]) {
      Object.keys(vegByFlight[key]).forEach(function (cid) {
        if (legend[cid] && legend[cid].visible) { map.addLayer(vegByFlight[key][cid]); }
      });
      return;
    }

    if (vegDataPromiseByFlight[key]) { return; } // ja esta buscando

    vegDataPromiseByFlight[key] = fetch("../data/" + fl.vegetation)
      .then(function (r) {
        if (!r.ok) { throw new Error("HTTP " + r.status); }
        return r.json();
      })
      .then(function (fc) {
        var byClass = {};
        fc.features.forEach(function (feat) {
          var cid = feat.properties.classe_id;
          (byClass[cid] = byClass[cid] || []).push(feat);
        });

        var groups = {};
        Object.keys(byClass).forEach(function (cidStr) {
          var cid = Number(cidStr);
          if (!legend[cid]) {
            legend[cid] = { name: "Classe " + cid, color: FALLBACK_PALETTE[0], opacity: DEFAULT_OPACITY, visible: true };
            legendOrder.push(cid);
            legendList.insertAdjacentHTML("beforeend", buildLegendRowHtml(cid));
            legendPanel.hidden = false;
          }
          var group = L.geoJSON({ type: "FeatureCollection", features: byClass[cidStr] }, {
            style: styleForClass(cid),
            onEachFeature: function (feature, layer) { layer.bindPopup(popupHtml(feature.properties)); }
          });
          groups[cid] = group;
          if (legend[cid].visible && activeFlights[key]) { group.addTo(map); }
        });
        vegByFlight[key] = groups;
      })
      .catch(function (err) {
        console.error("Falha ao carregar vegetacao de " + key, err);
        delete vegDataPromiseByFlight[key];
      });
  }

  function popupHtml(props) {
    return (
      "<b>" + (props.classe_nome || "—") + "</b><br>" +
      "Rótulo: " + (props.rotulo || "N/D") + "<br>" +
      "Área: " + fmtArea(Number(props.area_m2) || 0)
    );
  }

  // ------------------------------------------------------------------
  // Seletor de projeto + painel (blocos OU voo simples)
  // ------------------------------------------------------------------
  function populateProjectSelect() {
    projectSelect.innerHTML = projectOrder.map(function (pid) {
      return '<option value="' + pid + '">' + escapeHtml(projects[pid].name) + "</option>";
    }).join("");
  }
  projectSelect.addEventListener("change", function () { renderProjectPanel(this.value); });

  function renderProjectPanel(pid) {
    var proj = projects[pid];
    if (!proj) { projectPanelBody.innerHTML = ""; return; }
    projectSelect.value = pid;

    if (proj.blocks.length > 0) {
      renderBlocksPanel(proj);
    } else {
      renderSimplePanel(proj);
    }
  }

  function renderBlocksPanel(proj) {
    var chips = proj.blocks.map(function (block) {
      var fl = latestFlightForBlock(proj.id, block);
      var key = flightKey(proj.id, fl.date, block);
      var active = !!activeFlights[key];
      return (
        '<button type="button" class="block-chip' + (active ? " active" : "") + '" ' +
          'data-block="' + escapeHtml(block) + '" title="' + fmtDate(fl.date) + '">' +
          escapeHtml(block) +
        "</button>"
      );
    }).join("");

    var anyActive = proj.blocks.some(function (block) {
      var fl = latestFlightForBlock(proj.id, block);
      return !!activeFlights[flightKey(proj.id, fl.date, block)];
    });

    projectPanelBody.innerHTML =
      '<div class="blocks-head">' +
        '<label class="select-all-row"><input type="checkbox" id="blocksSelectAll" ' + (anyActive ? "checked" : "") + '> Selecionar todos</label>' +
        '<span class="blocks-count" id="blocksCount">' + countActiveBlocks(proj) + " selecionado(s)</span>" +
      "</div>" +
      '<div class="blocks-grid" id="blocksGrid">' + chips + "</div>";

    document.getElementById("blocksGrid").addEventListener("click", function (e) {
      var btn = e.target.closest(".block-chip");
      if (!btn) { return; }
      var block = btn.getAttribute("data-block");
      var fl = latestFlightForBlock(proj.id, block);
      var key = flightKey(proj.id, fl.date, block);
      var nowActive = !activeFlights[key];
      setFlightActive(proj.id, fl.date, block, nowActive);
      btn.classList.toggle("active", nowActive);
      document.getElementById("blocksCount").textContent = countActiveBlocks(proj) + " selecionado(s)";
      document.getElementById("blocksSelectAll").checked = countActiveBlocks(proj) === proj.blocks.length;
    });

    document.getElementById("blocksSelectAll").addEventListener("change", function () {
      var turnOn = this.checked;
      proj.blocks.forEach(function (block) {
        var fl = latestFlightForBlock(proj.id, block);
        setFlightActive(proj.id, fl.date, block, turnOn);
      });
      renderBlocksPanel(proj); // re-renderiza os chips com o novo estado
    });
  }

  function countActiveBlocks(proj) {
    return proj.blocks.filter(function (block) {
      var fl = latestFlightForBlock(proj.id, block);
      return !!activeFlights[flightKey(proj.id, fl.date, block)];
    }).length;
  }

  function renderSimplePanel(proj) {
    var dates = proj.flights.map(function (f) { return f.date; });
    var currentDate = dates[0];
    var activeDate = proj.flights.filter(function (f) {
      return activeFlights[flightKey(proj.id, f.date, null)];
    })[0];
    if (activeDate) { currentDate = activeDate.date; }

    var options = dates.map(function (d) {
      return '<option value="' + d + '"' + (d === currentDate ? " selected" : "") + ">" + fmtDate(d) + "</option>";
    }).join("");
    var isActive = !!activeFlights[flightKey(proj.id, currentDate, null)];

    projectPanelBody.innerHTML =
      '<div class="simple-row">' +
        '<label><input type="checkbox" id="simpleActive" ' + (isActive ? "checked" : "") + "> Ativar</label>" +
        '<select id="simpleDate">' + options + "</select>" +
      "</div>";

    document.getElementById("simpleActive").addEventListener("change", function () {
      setFlightActive(proj.id, document.getElementById("simpleDate").value, null, this.checked);
    });
    document.getElementById("simpleDate").addEventListener("change", function () {
      var wasActive = document.getElementById("simpleActive").checked;
      // desativa a data anterior (se estava ativa) e ativa a nova
      proj.flights.forEach(function (f) {
        var k = flightKey(proj.id, f.date, null);
        if (activeFlights[k] && f.date !== this.value) { setFlightActive(proj.id, f.date, null, false); }
      }, this);
      if (wasActive) { setFlightActive(proj.id, this.value, null, true); }
    });
  }

  function fmtDate(iso) {
    var parts = iso.split("-");
    return parts.length === 3 ? parts[2] + "/" + parts[1] + "/" + parts[0] : iso;
  }
  function fmtArea(m2) {
    return m2 >= 10000 ? (m2 / 10000).toFixed(2) + " ha" : m2.toFixed(0) + " m²";
  }
  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // ------------------------------------------------------------------
  // Comparar Ortofotos (swipe)
  // ------------------------------------------------------------------
  var swipeSelectA = document.getElementById("swipeA");
  var swipeSelectB = document.getElementById("swipeB");
  var btnSwipeToggle = document.getElementById("btnSwipeToggle");
  var swipeActive = false;
  var swipeLayers = { a: null, b: null };
  var swipeDom = { divider: null, handle: null, labelA: null, labelB: null };

  function populateSwipeSelects() {
    var opts = [];
    projectOrder.forEach(function (pid) {
      projects[pid].flights.forEach(function (fl) {
        if (!fl.hasOrtho) { return; }
        var label = projects[pid].name + (fl.block ? " / " + fl.block : "") + " — " + fmtDate(fl.date);
        opts.push('<option value="' + pid + "|" + fl.date + "|" + (fl.block || "") + '">' + escapeHtml(label) + "</option>");
      });
    });
    swipeSelectA.innerHTML = opts.join("");
    swipeSelectB.innerHTML = opts.join("");
    if (opts.length > 1) { swipeSelectB.selectedIndex = 1; }
    document.getElementById("swipePanel").hidden = opts.length === 0;
  }

  function flightFromSelectValue(val) {
    var parts = val.split("|");
    var pid = parts[0], date = parts[1], block = parts[2] || null;
    return { pid: pid, date: date, block: block, meta: findFlight(pid, date, block), name: projects[pid].name };
  }

  btnSwipeToggle.addEventListener("click", function () {
    if (swipeActive) { deactivateSwipe(); } else { activateSwipe(); }
  });

  function activateSwipe() {
    if (!swipeSelectA.value || !swipeSelectB.value) { return; }
    var a = flightFromSelectValue(swipeSelectA.value);
    var b = flightFromSelectValue(swipeSelectB.value);

    swipeLayers.a = L.tileLayer("../data/" + a.meta.tiles + "/{z}/{x}/{y}." + a.meta.tileExt, {
      maxZoom: 22, maxNativeZoom: a.meta.maxNativeZoom, minNativeZoom: a.meta.minNativeZoom, bounds: a.meta.bounds
    }).addTo(map);
    swipeLayers.b = L.tileLayer("../data/" + b.meta.tiles + "/{z}/{x}/{y}." + b.meta.tileExt, {
      maxZoom: 22, maxNativeZoom: b.meta.maxNativeZoom, minNativeZoom: b.meta.minNativeZoom, bounds: b.meta.bounds
    }).addTo(map);

    var mapWrap = document.getElementById("mapWrap");
    swipeDom.divider = document.createElement("div");
    swipeDom.divider.className = "swipe-divider";
    swipeDom.handle = document.createElement("div");
    swipeDom.handle.className = "swipe-handle";
    swipeDom.handle.textContent = "↔";
    swipeDom.divider.appendChild(swipeDom.handle);

    swipeDom.labelA = document.createElement("div");
    swipeDom.labelA.className = "swipe-label left";
    swipeDom.labelA.textContent = "A: " + a.name + (a.block ? " / " + a.block : "") + " — " + fmtDate(a.date);
    swipeDom.labelB = document.createElement("div");
    swipeDom.labelB.className = "swipe-label right";
    swipeDom.labelB.textContent = "B: " + b.name + (b.block ? " / " + b.block : "") + " — " + fmtDate(b.date);

    mapWrap.appendChild(swipeDom.divider);
    mapWrap.appendChild(swipeDom.labelA);
    mapWrap.appendChild(swipeDom.labelB);

    setSwipePosition(50);
    swipeDom.handle.addEventListener("mousedown", onSwipeDragStart);
    swipeDom.handle.addEventListener("touchstart", onSwipeDragStart, { passive: true });

    swipeActive = true;
    btnSwipeToggle.textContent = "Desativar comparação";
    btnSwipeToggle.classList.add("active");
  }

  function deactivateSwipe() {
    if (swipeLayers.a) { map.removeLayer(swipeLayers.a); swipeLayers.a = null; }
    if (swipeLayers.b) { map.removeLayer(swipeLayers.b); swipeLayers.b = null; }
    ["divider", "labelA", "labelB"].forEach(function (k) {
      if (swipeDom[k] && swipeDom[k].parentNode) { swipeDom[k].parentNode.removeChild(swipeDom[k]); }
      swipeDom[k] = null;
    });
    swipeActive = false;
    btnSwipeToggle.textContent = "Ativar comparação";
    btnSwipeToggle.classList.remove("active");
  }

  function setSwipePosition(pct) {
    pct = Math.max(0, Math.min(100, pct));
    swipeDom.divider.style.left = pct + "%";
    if (swipeLayers.b) {
      // L.TileLayer nao expoe um getContainer() publico (isso e do L.Map); o
      // proprio container da tile layer fica em _container.
      var container = swipeLayers.b._container;
      if (container) { container.style.clipPath = "inset(0 0 0 " + pct + "%)"; }
    }
  }

  function onSwipeDragStart(ev) {
    ev.preventDefault();
    document.addEventListener("mousemove", onSwipeDragMove);
    document.addEventListener("touchmove", onSwipeDragMove, { passive: false });
    document.addEventListener("mouseup", onSwipeDragEnd);
    document.addEventListener("touchend", onSwipeDragEnd);
  }
  function onSwipeDragMove(ev) {
    var clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    var rect = document.getElementById("map").getBoundingClientRect();
    setSwipePosition(((clientX - rect.left) / rect.width) * 100);
    if (ev.cancelable) { ev.preventDefault(); }
  }
  function onSwipeDragEnd() {
    document.removeEventListener("mousemove", onSwipeDragMove);
    document.removeEventListener("touchmove", onSwipeDragMove);
    document.removeEventListener("mouseup", onSwipeDragEnd);
    document.removeEventListener("touchend", onSwipeDragEnd);
  }

  // ------------------------------------------------------------------
  // Controles gerais da UI
  // ------------------------------------------------------------------
  document.getElementById("sidebarToggle").addEventListener("click", function () {
    document.getElementById("app").classList.toggle("sidebar-collapsed");
    setTimeout(function () { map.invalidateSize(); }, 250);
  });
  document.getElementById("btnHome").addEventListener("click", function () {
    if (allBounds) { map.fitBounds(allBounds); }
  });
  document.getElementById("btnFullscreen").addEventListener("click", function () {
    var el = document.documentElement;
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    }
  });
  var coordBox = document.getElementById("coordReadout");
  map.on("mousemove", function (e) {
    coordBox.textContent = e.latlng.lat.toFixed(6) + ", " + e.latlng.lng.toFixed(6);
  });
  map.on("mouseout", function () { coordBox.textContent = "lat, lon"; });

})();
