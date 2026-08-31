(function () {
  "use strict";

  var CLASS_DEFS = {
    1: { name: "Solo",                                   color: "#8B5E34" },
    2: { name: "Roço (até 0,40 m)",                       color: "#F4B400" },
    3: { name: "Poda Leve (0,40 m a 3,00 m)",             color: "#FF8C42" },
    4: { name: "Poda Seletiva (3,00 m a 8,00 m)",         color: "#E63946" },
    6: { name: "Não Identificado",                        color: "#9AA0A6" }
  };
  var CLASS_ORDER = [1, 2, 3, 4, 6];
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

  // Em áreas rurais o Esri World Imagery costuma não ter imagem em zooms muito
  // altos e devolve um tile placeholder ("Map data not yet available") em vez
  // de erro. maxNativeZoom trava as requisições nesse teto e deixa o Leaflet
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
  // Catálogo de projetos / voos
  // ------------------------------------------------------------------
  // projects[pid] = {
  //   id, name, flights: { date: flightMeta }, dates: [date,...] (desc),
  //   currentDate, orthoLayer, orthoVisible, orthoOpacity,
  //   vegState: { classId: {visible,color,opacity} },
  //   vegLayers: { classId: L.geoJSON|null },
  //   vegDataPromise: Promise|null  (cache do fetch do geojson do voo atual)
  // }
  var projects = {};
  var projectOrder = [];

  var projectListEl = document.getElementById("projectList");
  var catalogStatus = document.getElementById("catalogStatus");
  var allBounds = null; // acumula bounds de todo o catalogo, pro botao Home

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
      cat.forEach(function (p, idx) {
        initProject(p, idx === 0); // primeiro projeto ja vem ativo por padrao
      });
      catalogStatus.textContent = cat.length + " projeto(s) carregado(s).";
      populateSwipeSelects();
      if (allBounds) { map.fitBounds(allBounds); }
    })
    .catch(function (err) {
      catalogStatus.textContent = "Falha ao carregar catálogo: " + err.message;
      catalogStatus.style.color = "#c0392b";
      console.error(err);
    });

  function extendAllBounds(boundsArr) {
    var b = L.latLngBounds(boundsArr);
    allBounds = allBounds ? allBounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
  }

  function initProject(p, activeByDefault) {
    var flightsByDate = {};
    var dates = [];
    p.flights.forEach(function (fl) {
      flightsByDate[fl.date] = fl;
      dates.push(fl.date);
      extendAllBounds(fl.bounds);
    });

    var state = {
      id: p.id,
      name: p.name,
      flights: flightsByDate,
      dates: dates, // ja vem ordenado (mais recente primeiro) do catalog.json
      currentDate: dates[0],
      orthoLayer: null,
      orthoVisible: false,
      orthoOpacity: 100,
      vegState: {},
      vegLayers: {},
      vegDataPromise: null
    };
    CLASS_ORDER.forEach(function (cid) {
      state.vegState[cid] = {
        visible: !!activeByDefault,
        color: CLASS_DEFS[cid].color,
        opacity: DEFAULT_OPACITY
      };
      state.vegLayers[cid] = null;
    });
    state.orthoVisible = !!activeByDefault;

    projects[p.id] = state;
    projectOrder.push(p.id);
    projectListEl.appendChild(buildProjectCard(state));

    if (activeByDefault) {
      setOrtho(state.id, true);
      ensureVegDataLoaded(state.id).then(function () { refreshVegVisibility(state.id); });
    }
  }

  // ------------------------------------------------------------------
  // Card de projeto (DOM)
  // ------------------------------------------------------------------
  function buildProjectCard(state) {
    var card = document.createElement("div");
    card.className = "project-card";
    card.setAttribute("data-project", state.id);

    var vooOptions = state.dates.map(function (d) {
      return '<option value="' + d + '">' + fmtDate(d) + "</option>";
    }).join("");

    var fl = currentFlight(state.id);
    var classById = {};
    (fl && fl.classes || []).forEach(function (c) { classById[c.id] = c; });

    var vegCards = CLASS_ORDER.map(function (cid) {
      return buildVegCardHtml(cid, state.vegState[cid], classById[cid]);
    }).join("");

    card.innerHTML =
      '<div class="project-card-head">' +
        '<span class="project-card-name">' + escapeHtml(state.name) + '</span>' +
        '<select data-role="voo" data-project="' + state.id + '">' + vooOptions + '</select>' +
      '</div>' +
      '<div class="layer-card">' +
        '<div class="layer-card-head">' +
          '<input type="checkbox" ' + (state.orthoVisible ? "checked" : "") + ' data-role="ortho-visible" data-project="' + state.id + '">' +
          '<span class="layer-name">Ortofoto</span>' +
        '</div>' +
        '<div class="layer-card-body">' +
          '<span>opacidade</span>' +
          '<input type="range" min="0" max="100" value="' + state.orthoOpacity + '" data-role="ortho-opacity" data-project="' + state.id + '">' +
          '<span class="layer-opacity-val" data-role="ortho-opacity-val" data-project="' + state.id + '">' + state.orthoOpacity + '%</span>' +
        '</div>' +
      '</div>' +
      '<div class="veg-layers" data-project="' + state.id + '">' + vegCards + '</div>' +
      '<div class="project-summary" data-role="summary" data-project="' + state.id + '">' + summaryText(fl) + '</div>';

    return card;
  }

  function summaryText(fl) {
    if (!fl) { return ""; }
    var totalCount = 0, totalArea = 0;
    (fl.classes || []).forEach(function (c) { totalCount += c.count; totalArea += c.areaM2; });
    return fmtDate(fl.date) + " • " + totalCount + " feições • " + fmtArea(totalArea);
  }

  function buildVegCardHtml(classId, st, classInfo) {
    var def = CLASS_DEFS[classId];
    var count = classInfo ? classInfo.count : 0;
    var area = classInfo ? fmtArea(classInfo.areaM2) : "—";
    return (
      '<div class="layer-card">' +
        '<div class="layer-card-head">' +
          '<input type="checkbox" ' + (st.visible ? "checked" : "") + ' data-role="veg-visible" data-class="' + classId + '">' +
          '<span class="layer-name">' + def.name + '</span>' +
          '<span class="layer-count" data-role="veg-count" data-class="' + classId + '">' + count + '</span>' +
          '<input type="color" class="color-swatch" value="' + st.color + '" data-role="veg-color" data-class="' + classId + '">' +
        '</div>' +
        '<div class="layer-card-body">' +
          '<span>opacidade</span>' +
          '<input type="range" min="0" max="100" value="' + st.opacity + '" data-role="veg-opacity" data-class="' + classId + '">' +
          '<span class="layer-opacity-val" data-role="veg-opacity-val" data-class="' + classId + '">' + st.opacity + '%</span>' +
        '</div>' +
        '<div class="layer-area" data-role="veg-area" data-class="' + classId + '">área: ' + area + '</div>' +
      '</div>'
    );
  }

  function fmtDate(iso) {
    var parts = iso.split("-");
    if (parts.length !== 3) { return iso; }
    return parts[2] + "/" + parts[1] + "/" + parts[0];
  }

  function fmtArea(m2) {
    if (m2 >= 10000) { return (m2 / 10000).toFixed(2) + " ha"; }
    return m2.toFixed(0) + " m²";
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function currentFlight(pid) {
    var st = projects[pid];
    return st.flights[st.currentDate];
  }

  function updateProjectSummary(state) {
    var fl = currentFlight(state.id);
    var el = document.querySelector('[data-role="summary"][data-project="' + state.id + '"]');
    if (!el || !fl) { return; }
    var totalCount = 0, totalArea = 0;
    (fl.classes || []).forEach(function (c) { totalCount += c.count; totalArea += c.areaM2; });

    var byId = {};
    (fl.classes || []).forEach(function (c) { byId[c.id] = c; });

    // escopado ao card deste projeto (pode haver varios projetos na pagina)
    var card = document.querySelector('.project-card[data-project="' + state.id + '"]');
    if (card) {
      CLASS_ORDER.forEach(function (cid) {
        var c = byId[cid] || { count: 0, areaM2: 0 };
        var countEl = card.querySelector('[data-role="veg-count"][data-class="' + cid + '"]');
        var areaEl = card.querySelector('[data-role="veg-area"][data-class="' + cid + '"]');
        if (countEl) { countEl.textContent = c.count; }
        if (areaEl) { areaEl.textContent = "área: " + fmtArea(c.areaM2); }
      });
    }

    el.textContent = fl.date ? (fmtDate(fl.date) + " • " + totalCount + " feições • " + fmtArea(totalArea)) : "";
  }

  // ------------------------------------------------------------------
  // Ortofoto (lazy: só cria a tile layer quando o checkbox liga)
  // ------------------------------------------------------------------
  function setOrtho(pid, visible) {
    var state = projects[pid];
    state.orthoVisible = visible;
    var fl = currentFlight(pid);
    if (!fl) { return; }

    if (visible) {
      if (!state.orthoLayer) {
        state.orthoLayer = L.tileLayer(
          "../data/" + fl.tiles + "/{z}/{x}/{y}." + fl.tileExt,
          {
            minZoom: 3,
            maxZoom: 22,
            maxNativeZoom: fl.maxNativeZoom,
            minNativeZoom: fl.minNativeZoom,
            bounds: fl.bounds,
            opacity: state.orthoOpacity / 100,
            attribution: "Ortofoto local — " + state.name
          }
        );
      }
      state.orthoLayer.addTo(map);
    } else if (state.orthoLayer && map.hasLayer(state.orthoLayer)) {
      map.removeLayer(state.orthoLayer);
    }
  }

  function rebuildOrthoForNewDate(pid) {
    var state = projects[pid];
    var wasVisible = state.orthoVisible;
    if (state.orthoLayer && map.hasLayer(state.orthoLayer)) { map.removeLayer(state.orthoLayer); }
    state.orthoLayer = null;
    if (wasVisible) { setOrtho(pid, true); }
  }

  // ------------------------------------------------------------------
  // Vegetação (lazy: só busca o geojson do voo quando alguma classe liga)
  // ------------------------------------------------------------------
  function ensureVegDataLoaded(pid) {
    var state = projects[pid];
    var fl = currentFlight(pid);
    if (!fl) { return Promise.resolve(null); }
    if (state.vegDataPromise) { return state.vegDataPromise; }

    state.vegDataPromise = fetch("../data/" + fl.vegetation)
      .then(function (r) {
        if (!r.ok) { throw new Error("HTTP " + r.status); }
        return r.json();
      })
      .then(function (fc) {
        var byClass = {};
        CLASS_ORDER.forEach(function (cid) { byClass[cid] = []; });
        fc.features.forEach(function (feat) {
          var cid = feat.properties.classe_id;
          if (!byClass[cid]) { byClass[cid] = []; }
          byClass[cid].push(feat);
        });

        CLASS_ORDER.forEach(function (cid) {
          var group = L.geoJSON({ type: "FeatureCollection", features: byClass[cid] }, {
            style: vegStyleFor(pid, cid),
            onEachFeature: function (feature, layer) {
              layer.bindPopup(popupHtml(feature.properties));
            }
          });
          state.vegLayers[cid] = group;
        });
        return byClass;
      })
      .catch(function (err) {
        console.error("Falha ao carregar vegetacao de " + pid, err);
        state.vegDataPromise = null; // permite tentar de novo depois
        throw err;
      });

    return state.vegDataPromise;
  }

  function refreshVegVisibility(pid) {
    var state = projects[pid];
    CLASS_ORDER.forEach(function (cid) {
      var g = state.vegLayers[cid];
      if (!g) { return; }
      var visible = state.vegState[cid].visible;
      if (visible && !map.hasLayer(g)) { map.addLayer(g); }
      if (!visible && map.hasLayer(g)) { map.removeLayer(g); }
    });
  }

  function vegStyleFor(pid, classId) {
    var st = projects[pid].vegState[classId];
    return {
      color: st.color,
      weight: 1,
      opacity: 0.9,
      fillColor: st.color,
      fillOpacity: st.opacity / 100
    };
  }

  function applyVegStyle(pid, classId) {
    var g = projects[pid].vegLayers[classId];
    if (g) { g.setStyle(vegStyleFor(pid, classId)); }
  }

  function rebuildVegForNewDate(pid) {
    var state = projects[pid];
    CLASS_ORDER.forEach(function (cid) {
      var g = state.vegLayers[cid];
      if (g && map.hasLayer(g)) { map.removeLayer(g); }
      state.vegLayers[cid] = null;
    });
    state.vegDataPromise = null;
    var anyVisible = CLASS_ORDER.some(function (cid) { return state.vegState[cid].visible; });
    if (anyVisible) {
      ensureVegDataLoaded(pid).then(function () { refreshVegVisibility(pid); });
    }
  }

  function popupHtml(props) {
    return (
      "<b>" + (props.classe_nome || "—") + "</b><br>" +
      "Rótulo: " + (props.rotulo || "N/D") + "<br>" +
      "Área: " + fmtArea(Number(props.area_m2) || 0)
    );
  }

  // ------------------------------------------------------------------
  // Delegação de eventos do painel de projetos
  // ------------------------------------------------------------------
  projectListEl.addEventListener("change", function (e) {
    var role = e.target.getAttribute("data-role");
    if (!role) { return; }

    if (role === "voo") {
      var pid = e.target.getAttribute("data-project");
      projects[pid].currentDate = e.target.value;
      rebuildOrthoForNewDate(pid);
      rebuildVegForNewDate(pid);
      updateProjectSummary(projects[pid]);
      return;
    }

    if (role === "ortho-visible") {
      var opid = e.target.getAttribute("data-project");
      setOrtho(opid, e.target.checked);
      return;
    }

    if (role === "veg-visible" || role === "veg-color") {
      var card = e.target.closest(".project-card");
      var pid2 = card.getAttribute("data-project");
      var cid = Number(e.target.getAttribute("data-class"));
      if (role === "veg-visible") {
        projects[pid2].vegState[cid].visible = e.target.checked;
        if (e.target.checked) {
          ensureVegDataLoaded(pid2).then(function () { refreshVegVisibility(pid2); });
        } else {
          refreshVegVisibility(pid2);
        }
      } else {
        projects[pid2].vegState[cid].color = e.target.value;
        applyVegStyle(pid2, cid);
      }
    }
  });

  projectListEl.addEventListener("input", function (e) {
    var role = e.target.getAttribute("data-role");
    if (!role) { return; }

    if (role === "ortho-opacity") {
      var pid = e.target.getAttribute("data-project");
      var v = Number(e.target.value);
      projects[pid].orthoOpacity = v;
      document.querySelector('[data-role="ortho-opacity-val"][data-project="' + pid + '"]').textContent = v + "%";
      if (projects[pid].orthoLayer) { projects[pid].orthoLayer.setOpacity(v / 100); }
      return;
    }

    if (role === "veg-opacity") {
      var card = e.target.closest(".project-card");
      var pid2 = card.getAttribute("data-project");
      var cid = Number(e.target.getAttribute("data-class"));
      var v2 = Number(e.target.value);
      projects[pid2].vegState[cid].opacity = v2;
      card.querySelector('[data-role="veg-opacity-val"][data-class="' + cid + '"]').textContent = v2 + "%";
      applyVegStyle(pid2, cid);
    }
  });

  document.getElementById("btnResetColors").addEventListener("click", function () {
    projectOrder.forEach(function (pid) {
      var card = document.querySelector('.project-card[data-project="' + pid + '"]');
      CLASS_ORDER.forEach(function (cid) {
        var st = projects[pid].vegState[cid];
        st.color = CLASS_DEFS[cid].color;
        st.opacity = DEFAULT_OPACITY;
        card.querySelector('[data-role="veg-color"][data-class="' + cid + '"]').value = st.color;
        card.querySelector('[data-role="veg-opacity"][data-class="' + cid + '"]').value = st.opacity;
        card.querySelector('[data-role="veg-opacity-val"][data-class="' + cid + '"]').textContent = st.opacity + "%";
        applyVegStyle(pid, cid);
      });
    });
  });

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
    var optionsHtml = [];
    projectOrder.forEach(function (pid) {
      var state = projects[pid];
      state.dates.forEach(function (d) {
        optionsHtml.push('<option value="' + pid + "|" + d + '">' + escapeHtml(state.name) + " — " + fmtDate(d) + "</option>");
      });
    });
    swipeSelectA.innerHTML = optionsHtml.join("");
    swipeSelectB.innerHTML = optionsHtml.join("");
    if (optionsHtml.length > 1) { swipeSelectB.selectedIndex = 1; }
  }

  function flightFromSelectValue(val) {
    var parts = val.split("|");
    var pid = parts[0], date = parts[1];
    return { pid: pid, date: date, meta: projects[pid].flights[date], name: projects[pid].name };
  }

  btnSwipeToggle.addEventListener("click", function () {
    if (swipeActive) { deactivateSwipe(); } else { activateSwipe(); }
  });

  function activateSwipe() {
    if (!swipeSelectA.value || !swipeSelectB.value) { return; }
    var a = flightFromSelectValue(swipeSelectA.value);
    var b = flightFromSelectValue(swipeSelectB.value);

    swipeLayers.a = L.tileLayer("../data/" + a.meta.tiles + "/{z}/{x}/{y}." + a.meta.tileExt, {
      maxZoom: 22, maxNativeZoom: a.meta.maxNativeZoom, minNativeZoom: a.meta.minNativeZoom,
      bounds: a.meta.bounds
    }).addTo(map);
    swipeLayers.b = L.tileLayer("../data/" + b.meta.tiles + "/{z}/{x}/{y}." + b.meta.tileExt, {
      maxZoom: 22, maxNativeZoom: b.meta.maxNativeZoom, minNativeZoom: b.meta.minNativeZoom,
      bounds: b.meta.bounds
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
    swipeDom.labelA.textContent = "A: " + a.name + " — " + fmtDate(a.date);
    swipeDom.labelB = document.createElement("div");
    swipeDom.labelB.className = "swipe-label right";
    swipeDom.labelB.textContent = "B: " + b.name + " — " + fmtDate(b.date);

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
      // L.TileLayer nao expoe um getContainer() publico (isso e' do L.Map);
      // o proprio container da tile layer fica em _container (mesma
      // abordagem usada internamente pelo plugin leaflet-side-by-side).
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
    var pct = ((clientX - rect.left) / rect.width) * 100;
    setSwipePosition(pct);
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

  // vista inicial generica ate o catalogo carregar e ajustar via fitBounds
  map.setView([0, 0], 2);

})();
