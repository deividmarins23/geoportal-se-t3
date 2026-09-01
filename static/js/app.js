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

  // pane dedicado com z-index alto: garante que as camadas do swipe sempre
  // desenham por cima das camadas normais dos projetos, nao importa a ordem
  // em que foram ligadas -- sem isso, uma camada de projeto ligada depois do
  // swipe podia cobrir tudo e a comparacao parecia "nao fazer nada".
  // Dois panes: A embaixo (nunca recortado), B em cima (recortado pelo
  // divisor). Cortar o PANE em si (em vez do container interno de cada
  // camada) funciona igual pra ortofoto (raster) e vegetacao (vetor/SVG) --
  // qualquer camada que for adicionada aqui no futuro tambem funciona sem
  // precisar de tratamento especial por tipo.
  map.createPane("swipePaneA");
  map.createPane("swipePaneB");
  map.getPane("swipePaneA").style.zIndex = 649;
  map.getPane("swipePaneB").style.zIndex = 650;

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
  var blockSelectedDate = {}; // "pid::block" -> data escolhida (default: mais recente)

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

  function datesForBlock(pid, block) {
    return projects[pid].flights
      .filter(function (f) { return (f.block || null) === (block || null); })
      .map(function (f) { return f.date; }); // ja vem ordenado desc
  }

  function selectedDateForBlock(pid, block) {
    var key = pid + "::" + block;
    if (blockSelectedDate[key]) { return blockSelectedDate[key]; }
    var dates = datesForBlock(pid, block);
    return dates[0]; // sem preferencia salva: usa a mais recente
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
      var updatedEl = document.getElementById("dataUpdatedAt");
      if (updatedEl) { updatedEl.textContent = catalog.generatedAt || "—"; }
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
    legendPanel.hidden = false;
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
            bounds: fl.bounds, attribution: "Ortofoto local — " + projects[pid].name,
            // evita o "fantasma" de tile esticado via CSS que fica colado na
            // tela quando o zoom para em areas com muitos tiles (ex: usinas
            // solares) -- espera os tiles reais em vez de mostrar preview
            updateWhenZooming: false, updateWhenIdle: true
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
    var rows = proj.blocks.map(function (block) {
      var dates = datesForBlock(proj.id, block);
      var selDate = selectedDateForBlock(proj.id, block);
      var active = !!activeFlights[flightKey(proj.id, selDate, block)];

      var dateSelect = "";
      if (dates.length > 1) {
        var opts = dates.map(function (d) {
          return '<option value="' + d + '"' + (d === selDate ? " selected" : "") + ">" + fmtDate(d) + "</option>";
        }).join("");
        dateSelect = '<select class="block-date-select" data-block="' + escapeHtml(block) + '">' + opts + "</select>";
      }

      return (
        '<div class="block-row">' +
          '<button type="button" class="block-chip' + (active ? " active" : "") + '" ' +
            'data-block="' + escapeHtml(block) + '" title="' + fmtDate(selDate) + '">' +
            escapeHtml(block) +
          "</button>" +
          dateSelect +
        "</div>"
      );
    }).join("");

    projectPanelBody.innerHTML =
      '<div class="blocks-head">' +
        '<label class="select-all-row"><input type="checkbox" id="blocksSelectAll" ' +
          (countActiveBlocks(proj) === proj.blocks.length ? "checked" : "") + '> Selecionar todos</label>' +
        '<span class="blocks-count" id="blocksCount">' + countActiveBlocks(proj) + " selecionado(s)</span>" +
      "</div>" +
      '<div class="blocks-grid" id="blocksGrid">' + rows + "</div>";

    var grid = document.getElementById("blocksGrid");

    grid.addEventListener("click", function (e) {
      var btn = e.target.closest(".block-chip");
      if (!btn) { return; }
      var block = btn.getAttribute("data-block");
      var date = selectedDateForBlock(proj.id, block);
      var nowActive = !activeFlights[flightKey(proj.id, date, block)];
      setFlightActive(proj.id, date, block, nowActive);
      btn.classList.toggle("active", nowActive);
      document.getElementById("blocksCount").textContent = countActiveBlocks(proj) + " selecionado(s)";
      document.getElementById("blocksSelectAll").checked = countActiveBlocks(proj) === proj.blocks.length;
    });

    grid.addEventListener("change", function (e) {
      var sel = e.target.closest(".block-date-select");
      if (!sel) { return; }
      var block = sel.getAttribute("data-block");
      var oldDate = selectedDateForBlock(proj.id, block);
      var newDate = sel.value;
      var wasActive = !!activeFlights[flightKey(proj.id, oldDate, block)];

      blockSelectedDate[proj.id + "::" + block] = newDate;
      if (wasActive) {
        setFlightActive(proj.id, oldDate, block, false);
        setFlightActive(proj.id, newDate, block, true);
      }
      var btn = sel.parentElement.querySelector(".block-chip");
      if (btn) { btn.title = fmtDate(newDate); }
    });

    document.getElementById("blocksSelectAll").addEventListener("change", function () {
      var turnOn = this.checked;
      proj.blocks.forEach(function (block) {
        var date = selectedDateForBlock(proj.id, block);
        setFlightActive(proj.id, date, block, turnOn);
      });
      renderBlocksPanel(proj); // re-renderiza os chips com o novo estado
    });
  }

  function countActiveBlocks(proj) {
    return proj.blocks.filter(function (block) {
      var date = selectedDateForBlock(proj.id, block);
      return !!activeFlights[flightKey(proj.id, date, block)];
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
  // Comparar Camadas (swipe) -- ortofoto ou vegetacao, qualquer combinacao
  // ------------------------------------------------------------------
  var swipeSelectA = document.getElementById("swipeA");
  var swipeSelectB = document.getElementById("swipeB");
  var btnSwipeToggle = document.getElementById("btnSwipeToggle");
  var swipeActive = false;
  var swipeCurrentPct = 50;
  var swipeLayers = { a: null, b: null }; // cada lado e' um array de layers (1 se ortofoto, N se vegetacao)
  var swipeDom = { divider: null, handle: null, labelA: null, labelB: null };

  function populateSwipeSelects() {
    var opts = [];
    projectOrder.forEach(function (pid) {
      projects[pid].flights.forEach(function (fl) {
        var base = pid + "|" + fl.date + "|" + (fl.block || "");
        var label = projects[pid].name + (fl.block ? " / " + fl.block : "") + " — " + fmtDate(fl.date);
        if (fl.hasOrtho) { opts.push('<option value="' + base + '|ortho">' + escapeHtml(label) + " (Ortofoto)</option>"); }
        if (fl.hasVegetation) { opts.push('<option value="' + base + '|veg">' + escapeHtml(label) + " (Vegetação)</option>"); }
      });
    });
    swipeSelectA.innerHTML = opts.join("");
    swipeSelectB.innerHTML = opts.join("");
    if (opts.length > 1) { swipeSelectB.selectedIndex = 1; }
    document.getElementById("swipePanel").hidden = opts.length === 0;
  }

  function flightFromSelectValue(val) {
    var parts = val.split("|");
    var pid = parts[0], date = parts[1], block = parts[2] || null, type = parts[3];
    return { pid: pid, date: date, block: block, type: type, meta: findFlight(pid, date, block), name: projects[pid].name };
  }

  function swipeSideLabel(info) {
    return info.name + (info.block ? " / " + info.block : "") + " — " + fmtDate(info.date) +
      (info.type === "veg" ? " (Vegetação)" : " (Ortofoto)");
  }

  // Constroi a(s) layer(s) de um lado do swipe. Pane em si e' o que sera'
  // recortado (ver setSwipePosition) -- funciona igual pra tile layer
  // (ortofoto) ou grupos L.geoJSON (vegetacao), e vale pra qualquer camada
  // que seja adicionada no catalogo no futuro, sem precisar de tratamento
  // especial por tipo.
  function buildSwipeLayers(info, paneName) {
    if (info.type === "ortho") {
      return Promise.resolve([
        L.tileLayer("../data/" + info.meta.tiles + "/{z}/{x}/{y}." + info.meta.tileExt, {
          maxZoom: 22, maxNativeZoom: info.meta.maxNativeZoom, minNativeZoom: info.meta.minNativeZoom,
          bounds: info.meta.bounds, updateWhenZooming: false, updateWhenIdle: true, pane: paneName
        })
      ]);
    }
    return fetch("../data/" + info.meta.vegetation)
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
        return Object.keys(byClass).map(function (cidStr) {
          var cid = Number(cidStr);
          if (!legend[cid]) {
            legend[cid] = { name: "Classe " + cid, color: FALLBACK_PALETTE[0], opacity: DEFAULT_OPACITY, visible: true };
          }
          return L.geoJSON({ type: "FeatureCollection", features: byClass[cidStr] }, {
            pane: paneName,
            style: styleForClass(cid),
            onEachFeature: function (feature, layer) { layer.bindPopup(popupHtml(feature.properties)); }
          });
        });
      });
  }

  btnSwipeToggle.addEventListener("click", function () {
    if (swipeActive) { deactivateSwipe(); } else { activateSwipe(); }
  });

  function activateSwipe() {
    if (!swipeSelectA.value || !swipeSelectB.value) { return; }
    var a = flightFromSelectValue(swipeSelectA.value);
    var b = flightFromSelectValue(swipeSelectB.value);

    sizeSwipePanes();
    map.on("move zoom", onMapMoveDuringSwipe);

    var mapWrap = document.getElementById("mapWrap");
    swipeDom.divider = document.createElement("div");
    swipeDom.divider.className = "swipe-divider";
    swipeDom.handle = document.createElement("div");
    swipeDom.handle.className = "swipe-handle";
    swipeDom.handle.textContent = "↔";
    swipeDom.divider.appendChild(swipeDom.handle);

    swipeDom.labelA = document.createElement("div");
    swipeDom.labelA.className = "swipe-label left";
    swipeDom.labelA.textContent = "A: " + swipeSideLabel(a);
    swipeDom.labelB = document.createElement("div");
    swipeDom.labelB.className = "swipe-label right";
    swipeDom.labelB.textContent = "B: " + swipeSideLabel(b);

    mapWrap.appendChild(swipeDom.divider);
    mapWrap.appendChild(swipeDom.labelA);
    mapWrap.appendChild(swipeDom.labelB);

    setSwipePosition(50);
    swipeDom.handle.addEventListener("mousedown", onSwipeDragStart);
    swipeDom.handle.addEventListener("touchstart", onSwipeDragStart, { passive: true });

    swipeActive = true;
    btnSwipeToggle.textContent = "Desativar comparação";
    btnSwipeToggle.classList.add("active");

    buildSwipeLayers(a, "swipePaneA").then(function (layers) {
      swipeLayers.a = layers;
      if (swipeActive) { layers.forEach(function (l) { l.addTo(map); }); }
    });
    buildSwipeLayers(b, "swipePaneB").then(function (layers) {
      swipeLayers.b = layers;
      if (swipeActive) { layers.forEach(function (l) { l.addTo(map); }); }
    });
  }

  function deactivateSwipe() {
    map.off("move zoom", onMapMoveDuringSwipe);
    (swipeLayers.a || []).forEach(function (l) { map.removeLayer(l); });
    (swipeLayers.b || []).forEach(function (l) { map.removeLayer(l); });
    swipeLayers.a = null;
    swipeLayers.b = null;
    ["divider", "labelA", "labelB"].forEach(function (k) {
      if (swipeDom[k] && swipeDom[k].parentNode) { swipeDom[k].parentNode.removeChild(swipeDom[k]); }
      swipeDom[k] = null;
    });
    swipeActive = false;
    swipeCurrentPct = 50;
    btnSwipeToggle.textContent = "Ativar comparação";
    btnSwipeToggle.classList.remove("active");
  }

  function onMapMoveDuringSwipe() { setSwipePosition(swipeCurrentPct); }

  function sizeSwipePanes() {
    var mapSize = map.getSize();
    ["swipePaneA", "swipePaneB"].forEach(function (name) {
      var pane = map.getPane(name);
      if (pane) { pane.style.width = mapSize.x + "px"; pane.style.height = mapSize.y + "px"; }
    });
  }

  function setSwipePosition(pct) {
    pct = Math.max(0, Math.min(100, pct));
    swipeCurrentPct = pct;
    if (!swipeDom.divider) { return; }
    swipeDom.divider.style.left = pct + "%";

    // Cortamos o PANE inteiro (nao o container interno de cada camada) --
    // um pane e' um <div> que criamos e dimensionamos nos mesmos (ver
    // sizeSwipePanes), entao nao tem o problema de caixa 0x0 que as tile
    // layers tem. Funciona igual pra raster (tiles) e vetor (SVG).
    //
    // O Leaflet desloca o pane via transform (pan/zoom) sem que a origem
    // local dele fique alinhada com a borda visivel do mapa -- por isso
    // medimos a posicao REAL na tela (getBoundingClientRect) de ambos a
    // cada chamada, em vez de assumir que os dois comecam no mesmo (0,0).
    var paneB = map.getPane("swipePaneB");
    if (paneB) {
      sizeSwipePanes();
      var mapRect = document.getElementById("map").getBoundingClientRect();
      var paneRect = paneB.getBoundingClientRect();
      var dividerScreenX = mapRect.left + (mapRect.width * pct / 100);
      var xPx = Math.round(dividerScreenX - paneRect.left);
      paneB.style.clipPath = "inset(0px 0px 0px " + xPx + "px)";
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
