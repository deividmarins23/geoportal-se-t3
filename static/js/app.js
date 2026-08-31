(function () {
  "use strict";

  // Bounds do ortomosaico de origem (EPSG:4326), usados para o botao Home e
  // como limite da camada de tiles locais. Ver ORTO_WEBGIS.tif.
  var ORTHO_BOUNDS = [
    [-3.7922032250649997, -38.93378227704],   // southwest [lat, lon]
    [-3.785848226856, -38.926831922559]        // northeast [lat, lon]
  ];

  var CLASS_DEFS = [
    { id: 1, name: "Solo",                                   color: "#8B5E34" },
    { id: 2, name: "Roço (até 0,40 m)",                       color: "#F4B400" },
    { id: 3, name: "Poda Leve (0,40 m a 3,00 m)",             color: "#FF8C42" },
    { id: 4, name: "Poda Seletiva (3,00 m a 8,00 m)",         color: "#E63946" },
    { id: 6, name: "Não Identificado",                        color: "#9AA0A6" }
  ];
  var DEFAULT_OPACITY = 55; // %

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

  var orthoLayer = L.tileLayer("../data/tiles/{z}/{x}/{y}.png", {
    minZoom: 3,
    maxZoom: 22,
    maxNativeZoom: 21,
    minNativeZoom: 15,
    tms: false,
    bounds: ORTHO_BOUNDS,
    attribution: "Ortofoto local — SE-T3"
  });

  var esriLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 22, attribution: "Tiles &copy; Esri" }
  );

  var osmLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  });

  var baseLayers = { ortho: orthoLayer, esri: esriLayer, osm: osmLayer, none: null };
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

  var orthoOpacitySlider = document.getElementById("orthoOpacity");
  var orthoOpacityVal = document.getElementById("orthoOpacityVal");
  orthoOpacitySlider.addEventListener("input", function () {
    var v = Number(this.value);
    orthoOpacityVal.textContent = v + "%";
    orthoLayer.setOpacity(v / 100);
  });

  setBasemap("ortho");
  map.fitBounds(ORTHO_BOUNDS);

  // ------------------------------------------------------------------
  // Camadas de vegetacao
  // ------------------------------------------------------------------
  var layerState = {};   // id -> { visible, color, opacity }
  var layerGroups = {};  // id -> L.geoJSON
  var layerStats = {};   // id -> { count, areaM2 }

  var layerListEl = document.getElementById("layerList");

  CLASS_DEFS.forEach(function (def) {
    layerState[def.id] = { visible: true, color: def.color, opacity: DEFAULT_OPACITY };
    layerStats[def.id] = { count: 0, areaM2: 0 };
    layerListEl.appendChild(buildLayerCard(def));
  });

  function buildLayerCard(def) {
    var card = document.createElement("div");
    card.className = "layer-card";
    card.innerHTML =
      '<div class="layer-card-head">' +
        '<input type="checkbox" checked data-role="visible" data-id="' + def.id + '">' +
        '<span class="layer-name">' + def.name + '</span>' +
        '<span class="layer-count" data-role="count" data-id="' + def.id + '">0</span>' +
        '<input type="color" class="color-swatch" value="' + def.color + '" data-role="color" data-id="' + def.id + '">' +
      '</div>' +
      '<div class="layer-card-body">' +
        '<span>opacidade</span>' +
        '<input type="range" min="0" max="100" value="' + DEFAULT_OPACITY + '" data-role="opacity" data-id="' + def.id + '">' +
        '<span class="layer-opacity-val" data-role="opacityval" data-id="' + def.id + '">' + DEFAULT_OPACITY + '%</span>' +
      '</div>' +
      '<div class="layer-area" data-role="area" data-id="' + def.id + '">área: —</div>';
    return card;
  }

  layerListEl.addEventListener("change", function (e) {
    var role = e.target.getAttribute("data-role");
    var id = e.target.getAttribute("data-id");
    if (!role || !id) { return; }
    id = Number(id);

    if (role === "visible") {
      layerState[id].visible = e.target.checked;
      applyVisibility(id);
    } else if (role === "color") {
      layerState[id].color = e.target.value;
      applyStyle(id);
    }
  });

  layerListEl.addEventListener("input", function (e) {
    var role = e.target.getAttribute("data-role");
    var id = e.target.getAttribute("data-id");
    if (role !== "opacity" || !id) { return; }
    id = Number(id);
    layerState[id].opacity = Number(e.target.value);
    document.querySelector('[data-role="opacityval"][data-id="' + id + '"]').textContent = e.target.value + "%";
    applyStyle(id);
  });

  document.getElementById("btnResetColors").addEventListener("click", function () {
    CLASS_DEFS.forEach(function (def) {
      layerState[def.id].color = def.color;
      layerState[def.id].opacity = DEFAULT_OPACITY;
      document.querySelector('[data-role="color"][data-id="' + def.id + '"]').value = def.color;
      var opSlider = document.querySelector('[data-role="opacity"][data-id="' + def.id + '"]');
      opSlider.value = DEFAULT_OPACITY;
      document.querySelector('[data-role="opacityval"][data-id="' + def.id + '"]').textContent = DEFAULT_OPACITY + "%";
      applyStyle(def.id);
    });
  });

  function styleFor(id) {
    var st = layerState[id];
    return {
      color: st.color,
      weight: 1,
      opacity: 0.9,
      fillColor: st.color,
      fillOpacity: st.opacity / 100
    };
  }

  function applyStyle(id) {
    var g = layerGroups[id];
    if (g) { g.setStyle(styleFor(id)); }
  }

  function applyVisibility(id) {
    var g = layerGroups[id];
    if (!g) { return; }
    if (layerState[id].visible) {
      if (!map.hasLayer(g)) { map.addLayer(g); }
    } else {
      if (map.hasLayer(g)) { map.removeLayer(g); }
    }
  }

  function fmtArea(m2) {
    if (m2 >= 10000) { return (m2 / 10000).toFixed(2) + " ha"; }
    return m2.toFixed(0) + " m²";
  }

  function popupHtml(props) {
    return (
      "<b>" + (props.classe_nome || "—") + "</b><br>" +
      "Rótulo: " + (props.rotulo || "N/D") + "<br>" +
      "Área: " + fmtArea(Number(props.area_m2) || 0)
    );
  }

  // ------------------------------------------------------------------
  // Carrega o GeoJSON pre-processado e distribui nas 5 camadas
  // ------------------------------------------------------------------
  var loadStatus = document.getElementById("loadStatus");
  var vegSummary = document.getElementById("vegSummary");

  fetch("../data/vegetacao_4326.geojson")
    .then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.json();
    })
    .then(function (fc) {
      var byClass = {};
      CLASS_DEFS.forEach(function (def) { byClass[def.id] = []; });

      fc.features.forEach(function (feat) {
        var id = feat.properties.classe_id;
        if (!byClass[id]) { byClass[id] = []; }
        byClass[id].push(feat);
        var stats = layerStats[id] || (layerStats[id] = { count: 0, areaM2: 0 });
        stats.count += 1;
        stats.areaM2 += Number(feat.properties.area_m2) || 0;
      });

      var totalCount = 0, totalArea = 0;

      CLASS_DEFS.forEach(function (def) {
        var id = def.id;
        var feats = byClass[id] || [];
        var group = L.geoJSON({ type: "FeatureCollection", features: feats }, {
          style: styleFor(id),
          onEachFeature: function (feature, layer) {
            layer.bindPopup(popupHtml(feature.properties));
          }
        });
        layerGroups[id] = group;
        if (layerState[id].visible) { group.addTo(map); }

        var stats = layerStats[id];
        totalCount += stats.count;
        totalArea += stats.areaM2;

        document.querySelector('[data-role="count"][data-id="' + id + '"]').textContent = stats.count;
        document.querySelector('[data-role="area"][data-id="' + id + '"]').textContent = "área: " + fmtArea(stats.areaM2);
      });

      loadStatus.textContent = "Dados carregados.";
      vegSummary.textContent = totalCount + " feições  •  " + fmtArea(totalArea) + " no total";
    })
    .catch(function (err) {
      loadStatus.textContent = "Falha ao carregar vegetação: " + err.message;
      loadStatus.style.color = "#c0392b";
      console.error(err);
    });

  // ------------------------------------------------------------------
  // Controles gerais da UI
  // ------------------------------------------------------------------
  document.getElementById("sidebarToggle").addEventListener("click", function () {
    document.getElementById("app").classList.toggle("sidebar-collapsed");
    setTimeout(function () { map.invalidateSize(); }, 250);
  });

  document.getElementById("btnHome").addEventListener("click", function () {
    map.fitBounds(ORTHO_BOUNDS);
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
